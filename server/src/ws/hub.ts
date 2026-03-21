import { URL } from "node:url";
import type { IncomingMessage } from "node:http";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { CHAT_EVENT_TYPES } from "@paperclip-chat/shared";
import { authenticate, type Principal } from "../auth/authenticate.js";
import type { PaperclipClient } from "../adapters/paperclipClient.js";

export interface WsEnvelope {
  type: string;
  payload: unknown;
  timestamp: string;
}

export interface HubLogger {
  info(message: string): void;
  warn(message: string): void;
}

interface ClientState {
  principal: Principal;
  subscribedChannels: Set<string>;
  missedPongs: number;
}

interface UpgradeRequest {
  headers?: Record<string, string | undefined>;
  cookies?: Record<string, string | undefined>;
  principal?: Principal;
  userId?: string;
  companyId?: string;
  agentId?: string;
  sessionId?: string;
}

export class ChatWsHub {
  readonly server = new WebSocketServer({ noServer: true });
  private readonly clients = new Map<WebSocket, ClientState>();
  private keepaliveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly paperclipClient: Pick<PaperclipClient, "validateSession" | "validateAgentJwt">,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly logger: HubLogger = console,
  ) {}

  attach(httpServer: HttpServer): void {
    this.server.on("connection", (socket) => {
      socket.on("message", (raw) => this.onMessage(socket, raw));
      socket.on("pong", () => this.onPong(socket));
      socket.on("close", () => this.unregister(socket));
    });

    httpServer.on("upgrade", async (request, socket, head) => {
      const principal = await this.authenticateUpgrade(request);
      this.server.handleUpgrade(request, socket, head, (ws) => {
        if (!principal) {
          ws.close(4401, "Unauthorized");
          return;
        }

        this.register(ws, principal);
        this.server.emit("connection", ws, request);
      });
    });

    this.keepaliveTimer = setInterval(() => this.keepaliveTick(), 30_000);
  }

  close(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }

    for (const client of this.clients.keys()) {
      client.close();
    }
    this.clients.clear();
    this.server.close();
  }

  broadcast(channelId: string, event: Omit<WsEnvelope, "timestamp">): void {
    const message = serializeEnvelope(event);
    for (const [socket, state] of this.clients.entries()) {
      if (!state.subscribedChannels.has(channelId)) {
        continue;
      }
      socket.send(message);
    }
  }

  broadcastToUser(userId: string, event: Omit<WsEnvelope, "timestamp">): void {
    const message = serializeEnvelope(event);
    for (const [socket, state] of this.clients.entries()) {
      if (state.principal.type !== "human" || state.principal.id !== userId) {
        continue;
      }
      socket.send(message);
    }
  }

  isUserConnected(userId: string): boolean {
    for (const state of this.clients.values()) {
      if (state.principal.type === "human" && state.principal.id === userId) {
        return true;
      }
    }

    return false;
  }

  private register(socket: WebSocket, principal: Principal): void {
    this.logger.info(`WS client connected: ${principal.type}:${principal.id}`);
    this.clients.set(socket, {
      principal,
      subscribedChannels: new Set<string>(),
      missedPongs: 0,
    });
  }

  private unregister(socket: WebSocket): void {
    this.clients.delete(socket);
  }

  private onMessage(socket: WebSocket, raw: WebSocket.RawData): void {
    const state = this.clients.get(socket);
    if (!state) {
      return;
    }

    const parsed = parseJson(raw);
    if (!parsed || parsed.type !== "subscribe" || typeof parsed.channelId !== "string") {
      return;
    }

    state.subscribedChannels.add(parsed.channelId);
  }

  private onPong(socket: WebSocket): void {
    const state = this.clients.get(socket);
    if (!state) {
      return;
    }
    state.missedPongs = 0;
  }

  private keepaliveTick(): void {
    for (const [socket, state] of this.clients.entries()) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }

      if (state.missedPongs >= 1) {
        socket.terminate();
        this.unregister(socket);
        continue;
      }

      state.missedPongs += 1;
      socket.ping();
    }
  }

  private async authenticateUpgrade(request: IncomingMessage): Promise<Principal | null> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token");
    const authRequest: UpgradeRequest = {
      headers: normalizeHeaders({
        ...(request.headers as Record<string, string | string[] | undefined>),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      }),
    };

    let principal: Principal | null = null;
    const authResponse = createAuthResponse();
    await authenticate(
      authRequest,
      authResponse,
      async () => {
        principal = authRequest.principal ?? null;
      },
      this.paperclipClient,
      this.env,
    );
    return principal;
  }
}

function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value]),
  );
}

function parseJson(raw: WebSocket.RawData): Record<string, unknown> | null {
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
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function serializeEnvelope(event: Omit<WsEnvelope, "timestamp">): string {
  return JSON.stringify({
    ...event,
    timestamp: new Date().toISOString(),
  });
}

function createAuthResponse() {
  const response = {
    status: () => response,
    json: () => null,
  };
  return response;
}

export { CHAT_EVENT_TYPES };
