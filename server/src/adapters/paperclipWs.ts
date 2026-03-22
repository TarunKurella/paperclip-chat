import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket from "ws";

export interface AgentStatusEvent {
  agentId: string;
  status: string;
  timestamp: string;
}

export interface AgentRunLogEvent {
  agentId: string;
  message: string;
  timestamp: string;
}

export interface PresenceRecord {
  status: string;
  updatedAt: string;
}

export interface PaperclipWsConfig {
  baseUrl: string;
  companyId: string;
  serviceKey: string;
  reconnectDelaysMs?: number[];
  onAgentStatus?: (event: AgentStatusEvent) => void;
  onRunLog?: (event: AgentRunLogEvent) => void;
}

export interface PaperclipWsLogger {
  info(message: string): void;
  warn(message: string): void;
}

interface WebSocketLike extends EventEmitter {
  close(): void;
}

type WebSocketFactory = (url: string, init: { headers: Record<string, string> }) => WebSocketLike;

const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000];

export class PresenceStateMap {
  private readonly map = new Map<string, PresenceRecord>();

  update(event: AgentStatusEvent): void {
    this.map.set(event.agentId, {
      status: event.status,
      updatedAt: event.timestamp,
    });
  }

  get(agentId: string): PresenceRecord | undefined {
    return this.map.get(agentId);
  }

  snapshot(): Record<string, PresenceRecord> {
    return Object.fromEntries(this.map.entries());
  }
}

export class PaperclipWsSubscription {
  readonly presence = new PresenceStateMap();

  private readonly reconnectDelaysMs: number[];
  private readonly socketFactory: WebSocketFactory;
  private socket: WebSocketLike | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private stopping = false;

  constructor(
    private readonly config: PaperclipWsConfig,
    private readonly logger: PaperclipWsLogger = console,
    socketFactory?: WebSocketFactory,
  ) {
    this.reconnectDelaysMs = config.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.socketFactory = socketFactory ?? defaultSocketFactory;
  }

  start(): void {
    this.stopping = false;
    this.connect();
  }

  stop(): void {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    const url = buildPaperclipWsUrl(this.config.baseUrl, this.config.companyId);
    this.logger.info(`Paperclip WS connecting: ${url}`);

    const socket = this.socketFactory(url, {
      headers: {
        Authorization: `Bearer ${this.config.serviceKey}`,
        "X-Paperclip-Run-Id": `chat-server-${randomUUID()}`,
      },
    });

    this.socket = socket;
    socket.on("open", () => {
      this.reconnectAttempt = 0;
      this.logger.info("Paperclip WS connected");
    });
    socket.on("message", (raw) => {
      const statusEvent = parseAgentStatusEvent(raw);
      if (statusEvent) {
        this.presence.update(statusEvent);
        this.config.onAgentStatus?.(statusEvent);
        this.logger.info(`Paperclip agent.status ${statusEvent.agentId}=${statusEvent.status}`);
        return;
      }

      const runLogEvent = parseRunLogEvent(raw);
      if (!runLogEvent) {
        return;
      }

      this.config.onRunLog?.(runLogEvent);
      this.logger.info(`Paperclip heartbeat.run.log ${runLogEvent.agentId}`);
    });
    socket.on("close", () => {
      this.logger.warn("Paperclip WS disconnected");
      this.socket = null;
      if (!this.stopping) {
        this.scheduleReconnect();
      }
    });
    socket.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Paperclip WS error: ${message}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    const delay = this.reconnectDelaysMs[Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)] ?? 5_000;
    this.reconnectAttempt += 1;
    this.logger.info(`Paperclip WS reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopping) {
        this.connect();
      }
    }, delay);
  }
}

export function buildPaperclipWsUrl(baseUrl: string, companyId: string): string {
  const url = new URL(`/api/companies/${companyId}/events/ws`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function defaultSocketFactory(url: string, init: { headers: Record<string, string> }): WebSocketLike {
  return new WebSocket(url, { headers: init.headers }) as unknown as WebSocketLike;
}

function parseAgentStatusEvent(raw: unknown): AgentStatusEvent | null {
  const parsed = parseJson(raw);
  if (!parsed) {
    return null;
  }

  const eventType =
    typeof parsed.type === "string" ? parsed.type :
    typeof parsed.event === "string" ? parsed.event :
    null;
  if (eventType !== "agent.status") {
    return null;
  }

  const payload = isRecord(parsed.payload) ? parsed.payload : isRecord(parsed.data) ? parsed.data : null;
  if (!payload || typeof payload.agentId !== "string" || typeof payload.status !== "string") {
    return null;
  }

  return {
    agentId: payload.agentId,
    status: payload.status,
    timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : new Date().toISOString(),
  };
}

function parseRunLogEvent(raw: unknown): AgentRunLogEvent | null {
  const parsed = parseJson(raw);
  if (!parsed) {
    return null;
  }

  const eventType =
    typeof parsed.type === "string" ? parsed.type :
    typeof parsed.event === "string" ? parsed.event :
    null;
  if (eventType !== "heartbeat.run.log") {
    return null;
  }

  const payload = isRecord(parsed.payload) ? parsed.payload : isRecord(parsed.data) ? parsed.data : null;
  if (!payload || typeof payload.agentId !== "string" || typeof payload.message !== "string") {
    return null;
  }

  return {
    agentId: payload.agentId,
    message: payload.message,
    timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : new Date().toISOString(),
  };
}

function parseJson(raw: unknown): Record<string, unknown> | null {
  try {
    const text =
      typeof raw === "string" ? raw :
      Buffer.isBuffer(raw) ? raw.toString("utf8") :
      Array.isArray(raw) ? Buffer.concat(raw).toString("utf8") :
      raw instanceof ArrayBuffer ? Buffer.from(raw).toString("utf8") :
      null;

    if (!text) {
      return null;
    }

    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
