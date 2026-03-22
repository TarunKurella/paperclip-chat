import { createServer } from "node:http";
import express from "express";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_EVENT_TYPES, ChatWsHub } from "./hub.js";

describe("ChatWsHub", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  it("accepts websocket connections with valid auth", async () => {
    const { url, close } = await startHubServer();
    servers.push({ close });

    const client = new WebSocket(`${url}/ws?token=service-secret`);
    await waitForOpen(client);
    client.close();
  });

  it("rejects websocket connections without auth", async () => {
    const { url, close } = await startHubServer();
    servers.push({ close });

    const client = new WebSocket(`${url}/ws`);
    const closeEvent = await waitForClose(client);

    expect(closeEvent.code).toBe(4401);
  });

  it("broadcasts only to subscribers of a channel", async () => {
    const { url, hub, close } = await startHubServer();
    servers.push({ close });

    const subscriber = new WebSocket(`${url}/ws?token=service-secret`);
    const nonSubscriber = new WebSocket(`${url}/ws?token=service-secret`);
    await Promise.all([waitForOpen(subscriber), waitForOpen(nonSubscriber)]);

    subscriber.send(JSON.stringify({ type: "subscribe", channelId: "channel-1" }));
    nonSubscriber.send(JSON.stringify({ type: "subscribe", channelId: "channel-2" }));
    await delay(25);

    const subscriberMessage = waitForMessage(subscriber);
    const nonSubscriberMessages: string[] = [];
    nonSubscriber.on("message", (message) => nonSubscriberMessages.push(message.toString()));

    hub.broadcast("channel-1", {
      type: CHAT_EVENT_TYPES.CHAT_MESSAGE,
      payload: { text: "hello" },
    });

    const message = JSON.parse(await subscriberMessage);
    expect(message.type).toBe(CHAT_EVENT_TYPES.CHAT_MESSAGE);
    expect(message.payload).toEqual({ text: "hello" });
    expect(typeof message.timestamp).toBe("string");
    expect(nonSubscriberMessages).toHaveLength(0);

    subscriber.close();
    nonSubscriber.close();
  });

  it("replays missed turns on subscribe when last_seq is provided", async () => {
    const { url, hub, close } = await startHubServer();
    servers.push({ close });

    hub.setReplayProvider(async (_sessionId, lastSeq) => [
      {
        id: "turn-2",
        sessionId: "session-1",
        seq: lastSeq + 1,
        fromParticipantId: "agent-1",
        content: "caught up",
        tokenCount: 12,
        summarize: false,
        mentionedIds: null,
        isDecision: false,
        createdAt: new Date().toISOString(),
      },
    ]);

    const client = new WebSocket(`${url}/ws?token=service-secret`);
    await waitForOpen(client);

    const messagePromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "subscribe", channelId: "channel-1", sessionId: "session-1", lastSeq: 1 }));

    const message = JSON.parse(await messagePromise);
    expect(message.type).toBe(CHAT_EVENT_TYPES.CHAT_MESSAGE);
    expect(message.payload.turn.id).toBe("turn-2");
    expect(message.payload.turn.seq).toBe(2);

    client.close();
  });

  it("swallows replay errors for stale sessions", async () => {
    const { url, hub, close } = await startHubServer();
    servers.push({ close });

    hub.setReplayProvider(async () => {
      throw new Error("Chat session not found: stale-session");
    });

    const client = new WebSocket(`${url}/ws?token=service-secret`);
    await waitForOpen(client);

    client.send(JSON.stringify({ type: "subscribe", channelId: "channel-1", sessionId: "stale-session", lastSeq: 9 }));
    await delay(50);

    expect(client.readyState).toBe(WebSocket.OPEN);
    client.close();
  });

  it("broadcasts notifications to connected users", async () => {
    const { url, hub, close, paperclipClient } = await startHubServer();
    servers.push({ close });

    vi.mocked(paperclipClient.validateSession).mockResolvedValue({
      userId: "user-1",
      companyId: "company-1",
    });

    const client = new WebSocket(`${url}/ws`, {
      headers: { Cookie: "paperclip-session=session-cookie" },
    });
    await waitForOpen(client);

    const messagePromise = waitForMessage(client);
    hub.broadcastToUser("user-1", {
      type: CHAT_EVENT_TYPES.NOTIFICATION_NEW,
      payload: { id: "notification-1" },
    });

    const message = JSON.parse(await messagePromise);
    expect(message.type).toBe(CHAT_EVENT_TYPES.NOTIFICATION_NEW);
    expect(message.payload).toEqual({ id: "notification-1" });

    client.close();
  });

  it("broadcasts company-scoped presence events to matching principals", async () => {
    const { url, hub, close, paperclipClient } = await startHubServer();
    servers.push({ close });

    vi.mocked(paperclipClient.validateSession).mockResolvedValueOnce({
      userId: "user-1",
      companyId: "company-1",
    });
    vi.mocked(paperclipClient.validateSession).mockResolvedValueOnce({
      userId: "user-2",
      companyId: "company-2",
    });

    const companyOneClient = new WebSocket(`${url}/ws`, {
      headers: { Cookie: "paperclip-session=one" },
    });
    const companyTwoClient = new WebSocket(`${url}/ws`, {
      headers: { Cookie: "paperclip-session=two" },
    });
    await Promise.all([waitForOpen(companyOneClient), waitForOpen(companyTwoClient)]);

    const messagePromise = waitForMessage(companyOneClient);
    const nonMatchingMessages: string[] = [];
    companyTwoClient.on("message", (message) => nonMatchingMessages.push(message.toString()));

    hub.broadcastToCompany("company-1", {
      type: CHAT_EVENT_TYPES.AGENT_STATUS,
      payload: { agentId: "agent-1", status: "running" },
    });

    const message = JSON.parse(await messagePromise);
    expect(message.type).toBe(CHAT_EVENT_TYPES.AGENT_STATUS);
    expect(message.payload).toEqual({ agentId: "agent-1", status: "running" });
    expect(nonMatchingMessages).toHaveLength(0);

    companyOneClient.close();
    companyTwoClient.close();
  });

  it("terminates dead connections after two missed pongs", () => {
    const hub = new ChatWsHub(
      {
        validateSession: vi.fn(),
        validateAgentJwt: vi.fn(),
      },
      { CHAT_SERVICE_KEY: "service-secret" },
      { info: vi.fn(), warn: vi.fn() },
    );

    const socket = {
      readyState: WebSocket.OPEN,
      ping: vi.fn(),
      terminate: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;

    (hub as any).clients.set(socket, {
      principal: { type: "service", id: "paperclip-chat-server" },
      subscribedChannels: new Set<string>(),
      missedPongs: 0,
    });

    (hub as any).keepaliveTick();
    expect((socket as any).ping).toHaveBeenCalledOnce();

    (hub as any).keepaliveTick();
    expect((socket as any).terminate).toHaveBeenCalledOnce();
  });
});

async function startHubServer() {
  const app = express();
  const server = createServer(app);
  const paperclipClient = {
    validateSession: vi.fn().mockResolvedValue({ userId: "user-1", companyId: "company-1" }),
    validateAgentJwt: vi.fn(),
  };
  const hub = new ChatWsHub(
    paperclipClient,
    { CHAT_SERVICE_KEY: "service-secret", CHAT_TOKEN_SECRET: "chat-secret" },
    { info: vi.fn(), warn: vi.fn() },
  );
  hub.attach(server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server");
  }

  return {
    url: `ws://127.0.0.1:${address.port}`,
    hub,
    paperclipClient,
    close: async () => {
      hub.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function waitForOpen(client: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
}

function waitForClose(client: WebSocket): Promise<{ code: number; reason: Buffer }> {
  return new Promise((resolve) => {
    client.once("close", (code, reason) => resolve({ code, reason }));
  });
}

function waitForMessage(client: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    client.once("message", (message) => resolve(message.toString()));
    client.once("error", reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
