import { mkdtemp, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NormalizedBead } from "../orchestrator/beads.js";
import { Orchestrator, sortForDispatch, type WorkerRunner } from "../orchestrator/runtime.js";
import { WorkspaceManager } from "../orchestrator/workspace.js";
import type { WorkflowDefinition, ResolvedWorkflowConfig } from "../orchestrator/workflow.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("sortForDispatch", () => {
  it("sorts by priority, created_at, then identifier", () => {
    const sorted = sortForDispatch([
      bead("b", 2, "2026-03-21T10:00:00Z"),
      bead("a", 1, "2026-03-21T11:00:00Z"),
      bead("c", 1, "2026-03-21T09:00:00Z"),
    ]);

    expect(sorted.map((item) => item.identifier)).toEqual(["c", "a", "b"]);
  });
});

describe("Orchestrator", () => {
  it("dispatches eligible beads and schedules continuation retry on normal exit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-chat-runtime-"));
    tempDirs.push(root);

    const workflow: WorkflowDefinition = {
      path: "/repo/WORKFLOW.md",
      config: {},
      promptTemplate: "Do the bead work.",
    };

    const config = makeConfig(root);
    const ready = [bead("paperclip-chat-or3", 0, "2026-03-21T09:00:00Z")];
    const beadClient = {
      fetchReadyBeads: async () => ready,
      fetchBeadsByStatus: async () => ready,
      fetchBeadStatesByIdsOrIdentifiers: async () => ready,
    };
    const workspaceManager = new WorkspaceManager(
      { root },
      { timeoutMs: 5000 },
    );

    const workerRunner: WorkerRunner = async (_context, onEvent) => {
      onEvent({
        type: "session_started",
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
      });

      return {
        reason: "normal",
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        rateLimits: { limitId: "codex" },
      };
    };

    const orchestrator = new Orchestrator(workflow, config, beadClient, workspaceManager, workerRunner);
    const snapshot = await orchestrator.tick();

    expect(snapshot.running).toHaveLength(1);

    const deadline = Date.now() + 2000;
    let current = orchestrator.snapshot();

    while (Date.now() < deadline && current.retrying.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      current = orchestrator.snapshot();
    }

    expect(current.running).toEqual([]);
    expect(current.retrying).toHaveLength(1);
    expect(current.retrying[0]?.identifier).toBe("paperclip-chat-or3");
    expect(current.codexTotals.totalTokens).toBe(15);
    expect(current.rateLimits).toEqual({ limitId: "codex" });
  });

  it("executes configured claim and start commands before worker execution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-chat-runtime-"));
    tempDirs.push(root);

    const workflow: WorkflowDefinition = {
      path: path.join(root, "WORKFLOW.md"),
      config: {},
      promptTemplate: "Do the bead work.",
    };

    const config = makeConfig(root);
    const claimedPath = path.join(root, "claimed.txt");
    const startedPath = path.join(root, "started.txt");
    config.beads.claimCommandTemplate = `printf claimed > '${claimedPath}'`;
    config.beads.startCommandTemplate = `printf started > '${startedPath}'`;

    const ready = [bead("paperclip-chat-or3", 0, "2026-03-21T09:00:00Z")];
    const beadClient = {
      fetchReadyBeads: async () => ready,
      fetchBeadsByStatus: async () => ready,
      fetchBeadStatesByIdsOrIdentifiers: async () => ready,
    };
    const workspaceManager = new WorkspaceManager({ root }, { timeoutMs: 5000 });

    const workerRunner: WorkerRunner = async () => ({ reason: "normal" });

    const orchestrator = new Orchestrator(workflow, config, beadClient, workspaceManager, workerRunner);
    await orchestrator.tick();

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && orchestrator.snapshot().retrying.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(await readFile(claimedPath, "utf8")).toBe("claimed");
    expect(await readFile(startedPath, "utf8")).toBe("started");
  });
});

function bead(identifier: string, priority: number, createdAt: string): NormalizedBead {
  return {
    id: identifier,
    identifier,
    title: identifier,
    description: null,
    priority,
    status: "open",
    assignee: null,
    labels: [],
    dependsOn: [],
    createdAt,
    updatedAt: createdAt,
    raw: {},
  };
}

function makeConfig(root: string): ResolvedWorkflowConfig {
  return {
    workflowPath: path.join(root, "WORKFLOW.md"),
    beads: {
      command: "bd",
      readyArgs: ["ready", "--json"],
      showArgs: ["show", "{{ bead.identifier }}", "--json"],
      listArgs: ["list", "--json"],
      closedStatuses: ["closed"],
      activeStatuses: ["open", "in_progress"],
      claimOnDispatch: true,
    },
    polling: {
      intervalMs: 30000,
    },
    workspace: {
      root,
    },
    hooks: {
      timeoutMs: 5000,
    },
    agent: {
      maxConcurrentAgents: 2,
      maxRetryBackoffMs: 300000,
      maxTurns: 2,
      maxConcurrentAgentsByStatus: {},
    },
    codex: {
      command: "codex app-server",
      wsConnectTimeoutMs: 30000,
      turnTimeoutMs: 3600000,
      readTimeoutMs: 5000,
      stallTimeoutMs: 300000,
    },
  };
}
