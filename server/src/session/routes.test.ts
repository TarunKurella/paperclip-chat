import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { sessionRoutes } from "./routes.js";

describe("sessionRoutes", () => {
  it("opens a session", async () => {
    const sessionManager = {
      openSession: vi.fn().mockResolvedValue({ id: "session-1", channelId: "11111111-1111-4111-8111-111111111111" }),
      processTurn: vi.fn(),
      closeSession: vi.fn(),
      getSessionState: vi.fn(),
      getTokenUsage: vi.fn(),
      listMessages: vi.fn(),
    };

    const app = express();
    app.use(express.json());
    app.use(injectPrincipal());
    app.use("/api", sessionRoutes(sessionManager as never));

    const response = await request(app).post("/api/sessions").send({
      channelId: "11111111-1111-4111-8111-111111111111",
      participantIds: ["22222222-2222-4222-8222-222222222222"],
    });

    expect(response.status).toBe(201);
    expect(sessionManager.openSession).toHaveBeenCalledWith({
      channelId: "11111111-1111-4111-8111-111111111111",
      participantIds: ["22222222-2222-4222-8222-222222222222"],
    });
  });

  it("sends a message through processTurn using the authenticated principal", async () => {
    const sessionManager = {
      openSession: vi.fn(),
      processTurn: vi.fn().mockResolvedValue({ id: "turn-1" }),
      closeSession: vi.fn(),
      getSessionState: vi.fn(),
      getTokenUsage: vi.fn(),
      listMessages: vi.fn(),
    };

    const app = express();
    app.use(express.json());
    app.use(injectPrincipal());
    app.use("/api", sessionRoutes(sessionManager as never));

    const response = await request(app)
      .post("/api/sessions/session-1/send")
      .send({ text: "hello there", mentionedIds: ["33333333-3333-4333-8333-333333333333"] });

    expect(response.status).toBe(200);
    expect(sessionManager.processTurn).toHaveBeenCalledWith({
      sessionId: "session-1",
      fromParticipantId: "human-1",
      content: "hello there",
      mentionedIds: ["33333333-3333-4333-8333-333333333333"],
    });
  });

  it("closes a session", async () => {
    const sessionManager = {
      openSession: vi.fn(),
      processTurn: vi.fn(),
      closeSession: vi.fn().mockResolvedValue({ id: "session-1", status: "closed" }),
      getSessionState: vi.fn(),
      getTokenUsage: vi.fn(),
      listMessages: vi.fn(),
    };

    const app = express();
    app.use(express.json());
    app.use(injectPrincipal());
    app.use("/api", sessionRoutes(sessionManager as never));

    const response = await request(app).post("/api/sessions/session-1/close").send({});

    expect(response.status).toBe(200);
    expect(sessionManager.closeSession).toHaveBeenCalledWith("session-1");
  });

  it("returns session state", async () => {
    const sessionManager = {
      openSession: vi.fn(),
      processTurn: vi.fn(),
      closeSession: vi.fn(),
      getSessionState: vi.fn().mockResolvedValue({ session: { id: "session-1" }, agentStates: [] }),
      getTokenUsage: vi.fn(),
      listMessages: vi.fn(),
    };

    const app = express();
    app.use(express.json());
    app.use(injectPrincipal());
    app.use("/api", sessionRoutes(sessionManager as never));

    const response = await request(app).get("/api/sessions/session-1");

    expect(response.status).toBe(200);
    expect(sessionManager.getSessionState).toHaveBeenCalledWith("session-1");
  });

  it("returns token usage for a session", async () => {
    const sessionManager = {
      openSession: vi.fn(),
      processTurn: vi.fn(),
      closeSession: vi.fn(),
      getSessionState: vi.fn(),
      getTokenUsage: vi.fn().mockResolvedValue([{ id: "turn-1", tokenCount: 4 }]),
      listMessages: vi.fn(),
    };

    const app = express();
    app.use(express.json());
    app.use(injectPrincipal());
    app.use("/api", sessionRoutes(sessionManager as never));

    const response = await request(app).get("/api/sessions/session-1/tokens");

    expect(response.status).toBe(200);
    expect(sessionManager.getTokenUsage).toHaveBeenCalledWith("session-1");
  });

  it("returns message history with an optional cursor", async () => {
    const sessionManager = {
      openSession: vi.fn(),
      processTurn: vi.fn(),
      closeSession: vi.fn(),
      getSessionState: vi.fn(),
      getTokenUsage: vi.fn(),
      listMessages: vi.fn().mockResolvedValue([{ id: "turn-2", seq: 2 }]),
    };

    const app = express();
    app.use(express.json());
    app.use(injectPrincipal());
    app.use("/api", sessionRoutes(sessionManager as never));

    const response = await request(app)
      .get("/api/channels/channel-1/messages")
      .query({ sessionId: "session-1", cursor: "1" });

    expect(response.status).toBe(200);
    expect(sessionManager.listMessages).toHaveBeenCalledWith("session-1", 1);
  });
});

function injectPrincipal() {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { principal?: { id: string } }).principal = { id: "human-1" };
    next();
  };
}
