import { spawn } from "node:child_process";
import net from "node:net";

export interface CodexRunOptions {
  command: string;
  cwd: string;
  prompt: string;
  beadIdentifier: string;
  beadTitle: string;
  readTimeoutMs: number;
  wsUrl?: string;
  wsConnectTimeoutMs?: number;
  turnTimeoutMs: number;
  approvalPolicy?: string;
  threadSandbox?: string;
  turnSandboxPolicy?: unknown;
}

export interface CodexRunEvent {
  type:
    | "session_started"
    | "notification"
    | "stderr"
    | "turn_completed"
    | "turn_failed"
    | "turn_cancelled"
    | "malformed";
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  message?: string;
  method?: string;
  payload?: unknown;
}

export interface CodexRunResult {
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

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface CodexState {
  threadId: string | null;
  turnId: string | null;
  sessionId: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  rateLimits: unknown;
  completion?: CodexRunResult;
}

interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void,
  ): void;
}

const WebSocketCtor = (globalThis as typeof globalThis & { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;

export async function runCodexTurn(
  options: CodexRunOptions,
  onEvent?: (event: CodexRunEvent) => void,
): Promise<CodexRunResult> {
  if (!WebSocketCtor) {
    return {
      reason: "failed",
      error: "websocket_unsupported",
    };
  }

  const listenUrl = options.wsUrl ?? `ws://127.0.0.1:${await reservePort()}`;
  const connectTimeoutMs = options.wsConnectTimeoutMs ?? 30000;
  const child = options.wsUrl
    ? null
    : spawn("/bin/sh", ["-lc", `${options.command} --listen ${shellEscape(listenUrl)}`], {
        cwd: options.cwd,
        stdio: ["ignore", "ignore", "pipe"],
      });

  if (child && !child.stderr) {
    child.kill();
    return {
      reason: "failed",
      error: "codex_server_missing_stderr",
    };
  }

  const state: CodexState = {
    threadId: null,
    turnId: null,
    sessionId: null,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    rateLimits: null,
  };

  const pending = new Map<number, PendingRequest>();
  let nextRequestId = 1;
  let malformedCount = 0;
  let stderrBuffer = "";

  if (child?.stderr) {
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrBuffer += chunk.toString();
      while (true) {
        const index = stderrBuffer.search(/\r?\n/);
        if (index === -1) {
          break;
        }
        const line = stderrBuffer.slice(0, index).replace(/\r/g, "").trim();
        const step = stderrBuffer.startsWith("\r\n", index) ? 2 : 1;
        stderrBuffer = stderrBuffer.slice(index + step);
        if (!line) {
          continue;
        }
        onEvent?.({
          type: "stderr",
          message: line,
        });
      }
    });
  }

  const exitPromise = child
    ? new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      })
    : new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {});

  let socket: WebSocketLike;
  try {
    socket = await connectWebSocket(listenUrl, connectTimeoutMs);
  } catch (error) {
    child?.kill("SIGTERM");
    return {
      reason: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const cleanup = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(new Error("codex_app_server_stopped"));
    }
    pending.clear();
    socket.close();
  };

  socket.addEventListener("message", (event) => {
    const raw = typeof event.data === "string" ? event.data : event.data instanceof Buffer ? event.data.toString() : String(event.data ?? "");
    if (!raw.trim()) {
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      malformedCount += 1;
      onEvent?.({
        type: "malformed",
        message: raw,
      });
      return;
    }

    const responseId = typeof parsed.id === "number" ? parsed.id : null;
    if (responseId != null && pending.has(responseId)) {
      const entry = pending.get(responseId)!;
      clearTimeout(entry.timeout);
      pending.delete(responseId);

      if ("error" in parsed && parsed.error) {
        entry.reject(new Error(JSON.stringify(parsed.error)));
        return;
      }

      entry.resolve(parsed.result);
      return;
    }

    const method = typeof parsed.method === "string" ? parsed.method : null;
    if (!method) {
      return;
    }

    handleNotification(method, parsed.params, state, onEvent);
  });

  const request = async (method: string, params: unknown): Promise<unknown> => {
    const id = nextRequestId;
    nextRequestId += 1;

    socket.send(JSON.stringify({ id, method, params }));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`response_timeout:${method}`));
      }, options.readTimeoutMs);

      pending.set(id, { resolve, reject, timeout });
    });
  };

  const notify = (method: string, params?: unknown) => {
    socket.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  };

  const completionPromise = new Promise<CodexRunResult>((resolve) => {
    const interval = setInterval(() => {
      if (!state.completion) {
        return;
      }
      clearInterval(interval);
      resolve(state.completion);
    }, 25);
  });

  const turnTimeout = setTimeout(() => {
    state.completion = {
      reason: "failed",
      error: "turn_timeout",
      sessionId: state.sessionId ?? undefined,
      threadId: state.threadId ?? undefined,
      turnId: state.turnId ?? undefined,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      totalTokens: state.totalTokens,
      rateLimits: state.rateLimits,
    };
    child?.kill("SIGTERM");
  }, options.turnTimeoutMs);

  try {
    await request("initialize", {
      clientInfo: {
        name: "paperclip-chat-orchestrator",
        title: "Paperclip Chat Orchestrator",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: false,
      },
    });

    notify("initialized");

    const threadStart = await request("thread/start", {
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy ?? "never",
      sandbox: options.threadSandbox ?? "workspace-write",
      serviceName: "paperclip-chat-orchestrator",
      developerInstructions: `Execute bead ${options.beadIdentifier}: ${options.beadTitle}`,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    }) as { thread?: { id?: string } };

    state.threadId = threadStart.thread?.id ?? state.threadId;

    const turnStart = await request("turn/start", {
      threadId: state.threadId,
      input: [
        {
          type: "text",
          text: options.prompt,
          text_elements: [],
        },
      ],
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy ?? "never",
      sandboxPolicy: options.turnSandboxPolicy ?? createDefaultSandboxPolicy(options.cwd),
    }) as { turn?: { id?: string } };

    state.turnId = turnStart.turn?.id ?? state.turnId;
    state.sessionId = state.threadId && state.turnId ? `${state.threadId}-${state.turnId}` : null;

    onEvent?.({
      type: "session_started",
      sessionId: state.sessionId ?? undefined,
      threadId: state.threadId ?? undefined,
      turnId: state.turnId ?? undefined,
    });

    const result = await Promise.race([
      completionPromise,
      exitPromise.then(({ code, signal }) => ({
        reason: "failed" as const,
        error: `process_exit:${code ?? "null"}:${signal ?? "null"}`,
        sessionId: state.sessionId ?? undefined,
        threadId: state.threadId ?? undefined,
        turnId: state.turnId ?? undefined,
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        totalTokens: state.totalTokens,
        rateLimits: state.rateLimits,
      })),
    ]);

    return malformedCount > 0 && result.reason === "normal"
      ? { ...result, error: `malformed_messages:${malformedCount}` }
      : result;
  } catch (error) {
    child?.kill("SIGTERM");
    return {
      reason: "failed",
      error: error instanceof Error ? error.message : String(error),
      sessionId: state.sessionId ?? undefined,
      threadId: state.threadId ?? undefined,
      turnId: state.turnId ?? undefined,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      totalTokens: state.totalTokens,
      rateLimits: state.rateLimits,
    };
  } finally {
    clearTimeout(turnTimeout);
    cleanup();
  }
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!address || typeof address === "string") {
          reject(new Error("port_reservation_failed"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function connectWebSocket(url: string, timeoutMs: number): Promise<WebSocketLike> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const socket = await openWebSocket(url, Math.min(1000, Math.max(deadline - Date.now(), 1)));
      return socket;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error(
    lastError instanceof Error
      ? `websocket_connect_failed:${lastError.message}`
      : "websocket_connect_failed",
  );
}

async function openWebSocket(url: string, timeoutMs: number): Promise<WebSocketLike> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketCtor!(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("websocket_connect_timeout"));
    }, timeoutMs);

    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve(socket);
    });

    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("websocket_connect_error"));
    });
  });
}

function handleNotification(
  method: string,
  params: unknown,
  state: CodexState,
  onEvent?: (event: CodexRunEvent) => void,
): void {
  const payload = isRecord(params) ? params : {};
  const threadId = asString(payload.threadId) ?? state.threadId ?? undefined;
  const turn = isRecord(payload.turn) ? payload.turn : null;
  const turnId = turn ? asString(turn.id) ?? state.turnId ?? undefined : state.turnId ?? undefined;

  if (threadId) {
    state.threadId = threadId;
  }

  if (turnId) {
    state.turnId = turnId;
  }

  if (state.threadId && state.turnId) {
    state.sessionId = `${state.threadId}-${state.turnId}`;
  }

  if (method === "thread/tokenUsage/updated") {
    const tokenUsage = isRecord(payload.tokenUsage) ? payload.tokenUsage : {};
    const total = isRecord(tokenUsage.total) ? tokenUsage.total : {};
    state.inputTokens = asNumber(total.inputTokens) ?? state.inputTokens;
    state.outputTokens = asNumber(total.outputTokens) ?? state.outputTokens;
    state.totalTokens = asNumber(total.totalTokens) ?? state.totalTokens;
  } else if (method === "account/rateLimits/updated") {
    state.rateLimits = payload.rateLimits ?? state.rateLimits;
  } else if (method === "turn/completed") {
    const status = turn ? asString(turn.status) : null;
    state.completion = {
      reason: status === "completed" ? "normal" : "failed",
      error: status && status !== "completed" ? `turn_${status}` : undefined,
      sessionId: state.sessionId ?? undefined,
      threadId: state.threadId ?? undefined,
      turnId: state.turnId ?? undefined,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      totalTokens: state.totalTokens,
      rateLimits: state.rateLimits,
    };
  }

  onEvent?.({
    type:
      method === "turn/completed"
        ? turn && asString(turn.status) === "completed"
          ? "turn_completed"
          : turn && asString(turn.status) === "interrupted"
            ? "turn_cancelled"
            : "turn_failed"
        : "notification",
    sessionId: state.sessionId ?? undefined,
    threadId: state.threadId ?? undefined,
    turnId: state.turnId ?? undefined,
    method,
    payload: params,
  });
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function createDefaultSandboxPolicy(
  workspacePath: string,
): {
  type: "workspaceWrite";
  writableRoots: string[];
  readOnlyAccess: {
    type: "restricted";
    includePlatformDefaults: boolean;
    readableRoots: string[];
  };
  networkAccess: boolean;
  excludeTmpdirEnvVar: boolean;
  excludeSlashTmp: boolean;
} {
  return {
    type: "workspaceWrite",
    writableRoots: [workspacePath],
    readOnlyAccess: {
      type: "restricted",
      includePlatformDefaults: true,
      readableRoots: [],
    },
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}
