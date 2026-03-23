import { CHAT_EVENT_TYPES, type AgentChannelState, type Channel, type Turn } from "@paperclip-chat/shared";
import { signChatToken } from "../auth/chatTokens.js";
import type { WorkspaceResolution } from "./WorkspaceResolver.js";
import type { PresenceStateMachine } from "./PresenceStateMachine.js";
import { transitionOnCompletion } from "../context/AgentChannelState.js";
import { prepareManagedCodexHome, resolveManagedCodexHomeDir } from "./codexHome.js";

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

interface CliInvocationResult {
  result: SubprocessRunResult;
  resumed: boolean;
  reusedSessionId: string | null;
}

export interface RunCliInput {
  adapterType: string;
  cwd: string;
  args: string[];
  env: Record<string, string>;
  stdin: string;
}

export interface RunStateStore {
  saveAgentState(state: AgentChannelState): Promise<void>;
  listTurns(sessionId: string, options?: { limit?: number }): Promise<Turn[]>;
}

export interface StreamHub {
  broadcast(channelId: string, event: { type: string; payload: unknown }): void;
}

export interface SpawnRequest {
  adapterType: string;
  agentStatus?: string | null;
  agentId: string;
  agentName?: string | null;
  sessionId: string;
  channel: Channel;
  channelId: string;
  prompt: string;
  currentSeq: number;
  triggeringTurn: Turn;
  agentState: AgentChannelState;
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
    private readonly env: NodeJS.ProcessEnv | (() => Promise<NodeJS.ProcessEnv>) = process.env,
  ) {}

  async run(request: SpawnRequest): Promise<{ status: "queued" | "completed" }> {
    const env = await this.resolveEnv();
    const allowDirectDmSpawn = request.channel.type === "dm";
    debugDispatch("subprocess.run.start", {
      agentId: request.agentId,
      sessionId: request.sessionId,
      channelType: request.channel.type,
      presence: this.presence.getPresence(request.agentId),
      agentStatus: request.agentStatus ?? null,
    });
    if (!allowDirectDmSpawn && !this.presence.canSpawn(request.agentId) && !isSpawnablePaperclipStatus(request.agentStatus)) {
      this.hub.broadcast(request.channelId, {
        type: "agent.dispatch.queued",
        payload: {
          agentId: request.agentId,
          reason: "presence_blocked",
          presence: this.presence.getPresence(request.agentId),
          agentStatus: request.agentStatus ?? null,
        },
      });
      return { status: "queued" };
    }

    const prior = this.spawnLocks.get(request.agentId) ?? Promise.resolve();
    const runPromise = prior.then(async () => {
      this.presence.markChatBusy(request.agentId);
      this.hub.broadcast(request.channelId, {
        type: CHAT_EVENT_TYPES.AGENT_TYPING,
        payload: { participantId: request.agentId, active: true },
      });

      try {
        const workspace = await this.resolveWorkspace(request.channel, request.agentId, request.sessionId);
        debugDispatch("subprocess.run.workspace", {
          agentId: request.agentId,
          sessionId: request.sessionId,
          cwd: workspace.cwd,
        });
        const token = signChatToken(
          {
            agentId: request.agentId,
            sessionId: request.sessionId,
            companyId: request.channel.companyId,
          },
          env,
        );
        const cliInvocation = await runWithResumeFallback({
          request,
          workspace,
          token,
          env,
          runCli: this.runCli,
        });
        const cliResult = cliInvocation.result;
        debugDispatch("subprocess.run.cli_result", {
          agentId: request.agentId,
          sessionId: request.sessionId,
          streamCount: cliResult.stream?.length ?? 0,
          cliSessionId: cliResult.cliSessionId ?? null,
          resumed: cliInvocation.resumed,
          reusedSessionId: cliInvocation.reusedSessionId,
        });

        const fallbackText = (cliResult.stream ?? [])
          .filter((event) => event.type === "delta")
          .map((event) => event.delta)
          .join("")
          .trim();

        if (fallbackText) {
          const recentTurns = await this.stateStore.listTurns(request.sessionId, { limit: 10 });
          const hasAgentReply = recentTurns.some(
            (turn) => turn.fromParticipantId === request.agentId && turn.seq > request.triggeringTurn.seq,
          );
          if (!hasAgentReply) {
            debugDispatch("subprocess.run.fallback_post", {
              agentId: request.agentId,
              sessionId: request.sessionId,
              textLength: fallbackText.length,
            });
            await postFallbackTurn(
              resolveChatApiUrl(env),
              request.sessionId,
              token,
              fallbackText,
            );
          }
        }

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

        const nextState = transitionOnCompletion(request.agentState, request.currentSeq);
        await this.stateStore.saveAgentState({
          ...nextState,
          cliSessionId: cliResult.cliSessionId ?? cliInvocation.reusedSessionId ?? null,
          cliSessionPath: cliResult.cliSessionPath ?? workspace.sessionPath ?? request.agentState.cliSessionPath ?? null,
          tokensThisSession: (cliResult.actualInputTokens ?? 0) + (cliResult.outputTokens ?? 0),
        });
      } catch (error) {
        debugDispatch("subprocess.run.error", {
          agentId: request.agentId,
          sessionId: request.sessionId,
          message: error instanceof Error ? error.message : String(error),
        });
        this.hub.broadcast(request.channelId, {
          type: "agent.error",
          payload: {
            agentId: request.agentId,
            message: error instanceof Error ? error.message : "Unknown subprocess error",
          },
        });
        throw error;
      } finally {
        this.hub.broadcast(request.channelId, {
          type: CHAT_EVENT_TYPES.AGENT_TYPING,
          payload: { participantId: request.agentId, active: false },
        });
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

  private async resolveEnv(): Promise<NodeJS.ProcessEnv> {
    return typeof this.env === "function" ? this.env() : this.env;
  }
}

function debugDispatch(event: string, payload: Record<string, unknown>) {
  if (process.env.CHAT_DEBUG_DISPATCH !== "1") {
    return;
  }

  console.log(`[chat-dispatch] ${event}`, payload);
}

async function postFallbackTurn(chatApiUrl: string, sessionId: string, token: string, text: string): Promise<void> {
  if (!chatApiUrl.trim() || !text.trim()) {
    return;
  }

  const response = await fetch(`${chatApiUrl.replace(/\/$/, "")}/api/sessions/${sessionId}/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text, mentionedIds: [] }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || `Fallback chat send failed with ${response.status}`);
  }
}

function isSpawnablePaperclipStatus(status?: string | null): boolean {
  return status === "idle" || status === "available";
}

function resolveChatApiUrl(env: NodeJS.ProcessEnv): string {
  const explicit = env.CHAT_API_URL?.trim();
  if (explicit) {
    return explicit;
  }

  const host = env.CHAT_LISTEN_HOST?.trim() || env.HOST?.trim() || "127.0.0.1";
  const port = env.PORT?.trim() || "4000";
  return `http://${host}:${port}`;
}

function buildArgs(adapterType: string, cliSessionId?: string | null): string[] {
  if (adapterType === "codex_local") {
    return cliSessionId
      ? ["exec", "--json", "resume", cliSessionId, "-"]
      : ["exec", "--json", "-"];
  }

  return [
    "--print",
    "-",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(cliSessionId ? ["--resume", cliSessionId] : []),
  ];
}

async function runWithResumeFallback({
  request,
  workspace,
  token,
  env,
  runCli,
}: {
  request: SpawnRequest;
  workspace: WorkspaceResolution;
  token: string;
  env: NodeJS.ProcessEnv;
  runCli: CliRunner;
}): Promise<CliInvocationResult> {
  const baseEnv = await buildCliEnv(request, workspace, token, env);
  const resumeId = request.cliSessionId?.trim() || null;

  debugDispatch("subprocess.run.mode", {
    agentId: request.agentId,
    sessionId: request.sessionId,
    adapterType: request.adapterType,
    mode: resumeId ? "warm" : "cold",
    cliSessionId: resumeId,
  });

  const invoke = (cliSessionId?: string | null) =>
    runCli({
      adapterType: request.adapterType,
      cwd: workspace.cwd,
      args: buildArgs(request.adapterType, cliSessionId),
      env: baseEnv,
      stdin: request.prompt,
    });

  if (!resumeId) {
    return { result: await invoke(null), resumed: false, reusedSessionId: null };
  }

  try {
    return { result: await invoke(resumeId), resumed: true, reusedSessionId: resumeId };
  } catch (error) {
    if (!isRecoverableResumeError(error)) {
      throw error;
    }

    debugDispatch("subprocess.run.resume_recover", {
      agentId: request.agentId,
      sessionId: request.sessionId,
      adapterType: request.adapterType,
      staleCliSessionId: resumeId,
      message: error instanceof Error ? error.message : String(error),
    });

    return { result: await invoke(null), resumed: false, reusedSessionId: null };
  }
}

async function buildCliEnv(
  request: SpawnRequest,
  workspace: WorkspaceResolution,
  token: string,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, string>> {
  return {
    CHAT_API_URL: resolveChatApiUrl(env),
    CHAT_SESSION_ID: request.sessionId,
    CHAT_API_TOKEN: token,
    PAPERCLIP_API_URL: env.PAPERCLIP_API_URL ?? "",
    PAPERCLIP_AGENT_ID: request.agentId,
    PAPERCLIP_AGENT_NAME: request.agentName ?? "",
    PAPERCLIP_COMPANY_ID: request.channel.companyId,
    PAPERCLIP_WORKSPACE_CWD: workspace.cwd,
    AGENT_HOME: workspace.cwd,
    CODEX_HOME: request.adapterType === "codex_local"
      ? await prepareManagedCodexHome(env, request.channel.companyId)
      : resolveManagedCodexHomeDir(env, request.channel.companyId),
    PAPERCLIP_WAKE_REASON: "chat_message",
    PAPERCLIP_WAKE_COMMENT_ID: request.triggeringTurn.id,
  };
}

function isRecoverableResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const mentionsResumeState = ["resume", "session", "conversation", "thread"].some((token) => message.includes(token));
  const indicatesInvalidState = ["not found", "no such", "missing", "invalid", "expired"].some((token) => message.includes(token));
  return mentionsResumeState && indicatesInvalidState;
}
