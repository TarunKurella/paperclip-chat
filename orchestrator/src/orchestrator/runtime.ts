import { EventEmitter } from "node:events";
import { createDefaultSandboxPolicy, runCodexTurn } from "./codex.js";
import type { NormalizedBead } from "./beads.js";
import type { WorkspaceManager, WorkspaceRecord } from "./workspace.js";
import type { ResolvedWorkflowConfig, WorkflowDefinition } from "./workflow.js";

export interface RetryEntry {
  beadId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  error?: string;
}

export interface BeadClientLike {
  fetchReadyBeads(): Promise<NormalizedBead[]>;
  fetchBeadsByStatus(statuses: string[]): Promise<NormalizedBead[]>;
  fetchBeadStatesByIdsOrIdentifiers(refs: string[]): Promise<NormalizedBead[]>;
}

export interface RunningEntry {
  bead: NormalizedBead;
  identifier: string;
  attempt: number | null;
  startedAt: string;
  lastEventAt: string;
  workspace: WorkspaceRecord | null;
  sessionId: string | null;
  threadId: string | null;
  turnId: string | null;
}

export interface OrchestratorState {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retryAttempts: Map<string, RetryEntry>;
  completed: Set<string>;
  codexTotals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    secondsRunning: number;
  };
  codexRateLimits: unknown;
}

export interface WorkerResult {
  reason: "normal" | "failed";
  error?: string;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  rateLimits?: unknown;
}

export interface RuntimeSnapshot {
  running: Array<{ beadId: string; identifier: string; status: string; attempt: number | null }>;
  retrying: RetryEntry[];
  codexTotals: OrchestratorState["codexTotals"];
  rateLimits: unknown;
}

export interface WorkerRunContext {
  workflow: WorkflowDefinition;
  config: ResolvedWorkflowConfig;
  entry: RunningEntry;
  prompt: string;
}

export interface WorkerEvent {
  type: string;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  method?: string;
  message?: string;
  payload?: unknown;
}

export type WorkerRunner = (
  context: WorkerRunContext,
  onEvent: (event: WorkerEvent) => void,
) => Promise<WorkerResult>;

export class Orchestrator extends EventEmitter {
  readonly state: OrchestratorState;

  constructor(
    private readonly workflow: WorkflowDefinition,
    private readonly config: ResolvedWorkflowConfig,
    private readonly beadClient: BeadClientLike,
    private readonly workspaceManager: WorkspaceManager,
    private readonly workerRunner: WorkerRunner = defaultWorkerRunner,
  ) {
    super();
    this.state = {
      pollIntervalMs: config.polling.intervalMs,
      maxConcurrentAgents: config.agent.maxConcurrentAgents,
      running: new Map(),
      claimed: new Set(),
      retryAttempts: new Map(),
      completed: new Set(),
      codexTotals: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        secondsRunning: 0,
      },
      codexRateLimits: null,
    };
  }

  buildPrompt(bead: NormalizedBead, attempt: number | null, turnNumber = 1): string {
    const prompt = this.workflow.promptTemplate.trim() || "You are working on a bead from bd.";
    return [
      prompt,
      "",
      `Bead: ${bead.identifier} - ${bead.title}`,
      `Status: ${bead.status}`,
      `Attempt: ${attempt ?? "initial"}`,
      `Turn: ${turnNumber}/${this.config.agent.maxTurns}`,
      bead.description ? `Description: ${bead.description}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  }

  async tick(): Promise<RuntimeSnapshot> {
    await this.reconcileRunningBeads();

    const readyBeads = await this.beadClient.fetchReadyBeads();
    const sorted = sortForDispatch(readyBeads);

    for (const bead of sorted) {
      if (!this.shouldDispatch(bead)) {
        continue;
      }

      this.dispatchBead(bead, null);
    }

    return this.snapshot();
  }

  snapshot(): RuntimeSnapshot {
    return {
      running: Array.from(this.state.running.values()).map((entry) => ({
        beadId: entry.bead.id,
        identifier: entry.identifier,
        status: entry.bead.status,
        attempt: entry.attempt,
      })),
      retrying: Array.from(this.state.retryAttempts.values()),
      codexTotals: this.state.codexTotals,
      rateLimits: this.state.codexRateLimits,
    };
  }

  private shouldDispatch(bead: NormalizedBead): boolean {
    if (!this.config.beads.activeStatuses.includes(bead.status)) {
      return false;
    }

    if (this.config.beads.closedStatuses.includes(bead.status)) {
      return false;
    }

    if (this.state.running.has(bead.id) || this.state.claimed.has(bead.id)) {
      return false;
    }

    const globalSlots = Math.max(this.config.agent.maxConcurrentAgents - this.state.running.size, 0);
    if (globalSlots === 0) {
      return false;
    }

    const perStatusLimit =
      this.config.agent.maxConcurrentAgentsByStatus[bead.status] ?? this.config.agent.maxConcurrentAgents;
    const runningForStatus = Array.from(this.state.running.values()).filter((entry) => entry.bead.status === bead.status).length;

    return runningForStatus < perStatusLimit;
  }

  private dispatchBead(bead: NormalizedBead, attempt: number | null): void {
    const runningEntry: RunningEntry = {
      bead,
      identifier: bead.identifier,
      attempt,
      startedAt: new Date().toISOString(),
      lastEventAt: new Date().toISOString(),
      workspace: null,
      sessionId: null,
      threadId: null,
      turnId: null,
    };

    this.state.running.set(bead.id, runningEntry);
    this.state.claimed.add(bead.id);
    this.state.retryAttempts.delete(bead.id);

    void this.runWorkerAttempt(runningEntry)
      .then((result) => this.onWorkerExit(bead.id, result))
      .catch((error) =>
        this.onWorkerExit(bead.id, {
          reason: "failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }

  private async runWorkerAttempt(entry: RunningEntry): Promise<WorkerResult> {
    try {
      const workspace = await this.workspaceManager.createForBead(entry.identifier);
      entry.workspace = workspace;
      await this.workspaceManager.runBeforeRun(workspace.path);

      const result = await this.workerRunner(
        {
          workflow: this.workflow,
          config: this.config,
          entry,
          prompt: this.buildPrompt(entry.bead, entry.attempt, 1),
        },
        (event) => {
          entry.lastEventAt = new Date().toISOString();
          if (event.sessionId) {
            entry.sessionId = event.sessionId;
          }
          if (event.threadId) {
            entry.threadId = event.threadId;
          }
          if (event.turnId) {
            entry.turnId = event.turnId;
          }

          this.emit("notification", {
            beadId: entry.bead.id,
            sessionId: entry.sessionId,
            threadId: entry.threadId,
            turnId: entry.turnId,
            type: event.type,
            method: event.method,
            message: event.message,
            payload: event.payload,
          });
        },
      );

      await this.workspaceManager.runAfterRun(workspace.path);
      return result;
    } catch (error) {
      if (entry.workspace) {
        await this.workspaceManager.runAfterRun(entry.workspace.path);
      }

      return {
        reason: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async onWorkerExit(beadId: string, result: WorkerResult): Promise<void> {
    const runningEntry = this.state.running.get(beadId);
    if (!runningEntry) {
      return;
    }

    this.state.running.delete(beadId);
    this.state.codexTotals.secondsRunning += elapsedSeconds(runningEntry.startedAt);
    this.state.codexTotals.inputTokens += result.inputTokens ?? 0;
    this.state.codexTotals.outputTokens += result.outputTokens ?? 0;
    this.state.codexTotals.totalTokens += result.totalTokens ?? 0;
    if (result.rateLimits !== undefined) {
      this.state.codexRateLimits = result.rateLimits;
    }

    if (result.reason === "normal") {
      this.state.completed.add(beadId);
      this.scheduleRetry(beadId, runningEntry.identifier, 1, 1000);
    } else {
      const nextAttempt = (runningEntry.attempt ?? 0) + 1;
      const delayMs = Math.min(10000 * 2 ** Math.max(nextAttempt - 1, 0), this.config.agent.maxRetryBackoffMs);
      this.scheduleRetry(beadId, runningEntry.identifier, nextAttempt, delayMs, result.error);
    }
  }

  private scheduleRetry(
    beadId: string,
    identifier: string,
    attempt: number,
    delayMs: number,
    error?: string,
  ): void {
    this.state.retryAttempts.set(beadId, {
      beadId,
      identifier,
      attempt,
      dueAtMs: Date.now() + delayMs,
      error,
    });
  }

  private async reconcileRunningBeads(): Promise<void> {
    const refs = Array.from(this.state.running.keys());
    if (refs.length === 0) {
      return;
    }

    const refreshed = await this.beadClient.fetchBeadStatesByIdsOrIdentifiers(refs);
    const byId = new Map(refreshed.map((bead) => [bead.id, bead]));

    for (const [beadId, entry] of this.state.running.entries()) {
      const current = byId.get(beadId);
      if (!current) {
        continue;
      }

      entry.bead = current;
      if (this.config.beads.closedStatuses.includes(current.status)) {
        this.state.running.delete(beadId);
      }
    }
  }
}

async function defaultWorkerRunner(
  context: WorkerRunContext,
  onEvent: (event: WorkerEvent) => void,
): Promise<WorkerResult> {
  const workspacePath = context.entry.workspace?.path;
  if (!workspacePath) {
    return {
      reason: "failed",
      error: "workspace_not_initialized",
    };
  }

  return runCodexTurn(
    {
      command: context.config.codex.command,
      cwd: workspacePath,
      prompt: context.prompt,
      beadIdentifier: context.entry.identifier,
      beadTitle: context.entry.bead.title,
      readTimeoutMs: context.config.codex.readTimeoutMs,
      wsUrl: context.config.codex.wsUrl,
      wsConnectTimeoutMs: context.config.codex.wsConnectTimeoutMs,
      turnTimeoutMs: context.config.codex.turnTimeoutMs,
      approvalPolicy: context.config.codex.approvalPolicy,
      threadSandbox: context.config.codex.threadSandbox,
      turnSandboxPolicy: context.config.codex.turnSandboxPolicy ?? createDefaultSandboxPolicy(workspacePath),
    },
    onEvent,
  );
}

export function sortForDispatch(beads: NormalizedBead[]): NormalizedBead[] {
  return [...beads].sort((left, right) => {
    const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    const leftCreated = left.createdAt ?? "";
    const rightCreated = right.createdAt ?? "";
    if (leftCreated !== rightCreated) {
      return leftCreated.localeCompare(rightCreated);
    }

    return left.identifier.localeCompare(right.identifier);
  });
}

function elapsedSeconds(startedAt: string): number {
  return Math.max((Date.now() - new Date(startedAt).getTime()) / 1000, 0);
}
