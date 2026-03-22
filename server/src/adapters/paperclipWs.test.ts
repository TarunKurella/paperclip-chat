import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPaperclipWsUrl, PaperclipWsSubscription } from "./paperclipWs.js";

describe("buildPaperclipWsUrl", () => {
  it("converts the Paperclip base URL into a company events websocket URL", () => {
    expect(buildPaperclipWsUrl("http://localhost:3100", "company-1")).toBe(
      "ws://localhost:3100/api/companies/company-1/events/ws",
    );
    expect(buildPaperclipWsUrl("https://paperclip.example.com", "company-1")).toBe(
      "wss://paperclip.example.com/api/companies/company-1/events/ws",
    );
  });
});

describe("PaperclipWsSubscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores agent.status events in the presence map", () => {
    const socket = new FakeSocket();
    const factory = vi.fn(() => socket);
    const logger = createLogger();
    const client = new PaperclipWsSubscription(
      {
        baseUrl: "http://localhost:3100",
        companyId: "company-1",
        serviceKey: "secret",
      },
      logger,
      factory,
    );

    client.start();
    socket.emit("open");
    socket.emit(
      "message",
      JSON.stringify({
        type: "agent.status",
        timestamp: "2026-03-21T20:00:00.000Z",
        payload: { agentId: "agent-1", status: "running" },
      }),
    );

    expect(client.presence.get("agent-1")).toEqual({
      status: "running",
      updatedAt: "2026-03-21T20:00:00.000Z",
    });
    expect(logger.info).toHaveBeenCalledWith("Paperclip WS connected");
    expect(logger.info).toHaveBeenCalledWith("Paperclip agent.status agent-1=running");
  });

  it("forwards agent.status events to the configured callback", () => {
    const socket = new FakeSocket();
    const onAgentStatus = vi.fn();
    const client = new PaperclipWsSubscription(
      {
        baseUrl: "http://localhost:3100",
        companyId: "company-1",
        serviceKey: "secret",
        onAgentStatus,
      },
      createLogger(),
      vi.fn(() => socket),
    );

    client.start();
    socket.emit(
      "message",
      JSON.stringify({
        type: "agent.status",
        timestamp: "2026-03-21T20:00:00.000Z",
        payload: { agentId: "agent-1", status: "running" },
      }),
    );

    expect(onAgentStatus).toHaveBeenCalledWith({
      agentId: "agent-1",
      status: "running",
      timestamp: "2026-03-21T20:00:00.000Z",
    });
  });

  it("reconnects with exponential backoff after disconnect", () => {
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const factory = vi.fn()
      .mockReturnValueOnce(firstSocket)
      .mockReturnValueOnce(secondSocket);
    const logger = createLogger();
    const client = new PaperclipWsSubscription(
      {
        baseUrl: "http://localhost:3100",
        companyId: "company-1",
        serviceKey: "secret",
        reconnectDelaysMs: [1_000, 2_000, 5_000],
      },
      logger,
      factory,
    );

    client.start();
    firstSocket.emit("close");

    expect(logger.warn).toHaveBeenCalledWith("Paperclip WS disconnected");
    expect(logger.info).toHaveBeenCalledWith("Paperclip WS reconnecting in 1000ms");

    vi.advanceTimersByTime(1_000);

    expect(factory).toHaveBeenCalledTimes(2);
  });
});

class FakeSocket extends EventEmitter {
  close(): void {
    this.emit("close");
  }
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}
