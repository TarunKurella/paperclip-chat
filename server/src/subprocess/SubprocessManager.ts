import { CHAT_EVENT_TYPES, type Channel, type Turn } from "@paperclip-chat/shared";
import { signChatToken } from "../auth/chatTokens.js";
import type { WorkspaceResolution } from "./WorkspaceResolver.js";
import type { PresenceStateMachine } from "./PresenceStateMachine.js";

export interface SubprocessStreamEvent {
  type: "delta";
  delta: string;
}

export interface SubprocessRunResult {
  cliSessionId?: string | null;
  cliSessionPath?: string | null;
  actualInputTokens?: number;
  outputTokens?: number;
  stream?: SubprocessStreamEvent[];
}

export interface RunCliInput {
  cwd: string;
  args: string[];
  env: Record<string, string>;
}

export interface RunStateStore {
  saveRunState(input: {
    sessionId: string;
    participantId: string;
    cliSessionId: string | null;
    cliSessionPath: string | null;
    anchorSeq: number;
    tokensThisSession: number;
  }): Promise<void>;
}

export interface StreamHub {
  broadcast(channelId: string, event: { type: string; payload: unknown }): void;
}

export interface SpawnRequest {
  agentId: string;
  sessionId: string;
  channel: Channel;
  channelId: string;
  prompt: string;
  currentSeq: number;
  triggeringTurn: Turn;
  cliSessionId?: string | null;
}

export interface WorkspaceResolverFn {
  (channel: Channel, agentId: string, sessionId: string): Promise<WorkspaceResolution>;
}

export interface CliRunner {
  (input: RunCliInput): Promise<SubprocessRunResult>;
}

export class SubprocessManager {
  private readonly spawnLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly presence: PresenceStateMachine,
    private readonly resolveWorkspace: WorkspaceResolverFn,
    private readonly runCli: CliRunner,
    private readonly stateStore: RunStateStore,
    private readonly hub: StreamHub,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async run(request: SpawnRequest): Promise<{ status: "queued" | "completed" }> {
    if (!this.presence.canSpawn(request.agentId)) {
      return { status: "queued" };
    }

    const prior = this.spawnLocks.get(request.agentId) ?? Promise.resolve();
    const runPromise = prior.then(async () => {
      this.presence.markChatBusy(request.agentId);

      try {
        const workspace = await this.resolveWorkspace(request.channel, request.agentId, request.sessionId);
        const token = signChatToken(
          {
            agentId: request.agentId,
            sessionId: request.sessionId,
            companyId: request.channel.companyId,
          },
          this.env,
        );
        const cliResult = await this.runCli({
          cwd: workspace.cwd,
          args: buildArgs(request.prompt, request.cliSessionId),
          env: {
            CHAT_API_URL: this.env.CHAT_API_URL ?? this.env.PAPERCLIP_API_URL ?? "",
            CHAT_SESSION_ID: request.sessionId,
            CHAT_API_TOKEN: token,
            PAPERCLIP_WAKE_REASON: "chat_message",
            PAPERCLIP_WAKE_COMMENT_ID: request.triggeringTurn.id,
          },
        });

        for (const event of cliResult.stream ?? []) {
          this.hub.broadcast(request.channelId, {
            type: CHAT_EVENT_TYPES.CHAT_MESSAGE_STREAM,
            payload: { delta: event.delta, done: false, participantId: request.agentId },
          });
        }

        this.hub.broadcast(request.channelId, {
          type: CHAT_EVENT_TYPES.CHAT_MESSAGE_STREAM,
          payload: { delta: "", done: true, participantId: request.agentId },
        });

        await this.stateStore.saveRunState({
          sessionId: request.sessionId,
          participantId: request.agentId,
          cliSessionId: cliResult.cliSessionId ?? request.cliSessionId ?? null,
          cliSessionPath: cliResult.cliSessionPath ?? null,
          anchorSeq: request.currentSeq,
          tokensThisSession: (cliResult.actualInputTokens ?? 0) + (cliResult.outputTokens ?? 0),
        });
      } catch (error) {
        this.hub.broadcast(request.channelId, {
          type: "agent.error",
          payload: {
            agentId: request.agentId,
            message: error instanceof Error ? error.message : "Unknown subprocess error",
          },
        });
        throw error;
      } finally {
        this.presence.markChatIdle(request.agentId);
      }
    });

    const trackedPromise = runPromise.catch(() => undefined).finally(() => {
      if (this.spawnLocks.get(request.agentId) === trackedPromise) {
        this.spawnLocks.delete(request.agentId);
      }
    });

    this.spawnLocks.set(request.agentId, trackedPromise);

    await runPromise;
    return { status: "completed" };
  }
}

function buildArgs(prompt: string, cliSessionId?: string | null): string[] {
  return [
    ...(cliSessionId ? ["--resume", cliSessionId] : []),
    "--print",
    prompt,
    "--output-format",
    "stream-json",
  ];
}
