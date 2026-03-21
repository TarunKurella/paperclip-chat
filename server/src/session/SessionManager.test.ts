import type { AgentChannelState, ChatSession, Turn } from "@paperclip-chat/shared";
import { CHAT_DEFAULTS, CHAT_EVENT_TYPES } from "@paperclip-chat/shared";
import { describe, expect, it, vi } from "vitest";
import { SessionManager, SessionNotFoundError, type NotificationRecord, type SessionParticipant } from "./SessionManager.js";

describe("SessionManager", () => {
  it("inserts turns, broadcasts them, and enqueues mentioned agents", async () => {
    const fixture = createFixture();

    const turn = await fixture.manager.processTurn({
      sessionId: "session-1",
      fromParticipantId: "human-1",
      content: "Hey @agent-1 please check auth",
      mentionedIds: ["agent-1"],
    });

    expect(turn.id).toBe("turn-1");
    expect(fixture.trunkManager.insertTurn).toHaveBeenCalledOnce();
    expect(fixture.hub.broadcast).toHaveBeenCalledWith("channel-1", {
      type: CHAT_EVENT_TYPES.CHAT_MESSAGE,
      payload: { turn },
    });
    expect(fixture.debounce.enqueue).toHaveBeenCalledWith("agent-1", "session-1", turn);
  });

  it("opens a session and creates agent states for agent participants", async () => {
    const fixture = createFixture({
      participants: [
        { participantId: "human-1", participantType: "human", companyId: "company-1" },
        { participantId: "agent-1", participantType: "agent", companyId: "company-1" },
        { participantId: "agent-2", participantType: "agent", companyId: "company-1" },
      ],
    });

    const session = await fixture.manager.openSession({
      channelId: "channel-1",
      participantIds: ["human-1", "agent-2"],
    });

    expect(session.id).toBe("session-1");
    expect(fixture.repository.createSession).toHaveBeenCalledWith("channel-1", [
      { participantId: "human-1", participantType: "human", companyId: "company-1" },
      { participantId: "agent-2", participantType: "agent", companyId: "company-1" },
    ]);
    expect(fixture.repository.createAgentStates).toHaveBeenCalledWith("session-1", ["agent-2"]);
    expect(fixture.paperclipClient.getAgent).toHaveBeenCalledWith("agent-2");
  });

  it("closes a session and emits a session.closed event", async () => {
    const fixture = createFixture();

    const session = await fixture.manager.closeSession("session-1");

    expect(session.id).toBe("session-1");
    expect(fixture.repository.closeSession).toHaveBeenCalledWith("session-1");
    expect(fixture.hub.broadcast).toHaveBeenCalledWith("channel-1", {
      type: CHAT_EVENT_TYPES.SESSION_CLOSED,
      payload: { sessionId: "session-1" },
    });
  });

  it("creates notifications for offline humans only", async () => {
    const fixture = createFixture({
      participants: [
        { participantId: "human-1", participantType: "human", companyId: "company-1" },
        { participantId: "human-2", participantType: "human", companyId: "company-1" },
        { participantId: "human-3", participantType: "human", companyId: "company-1" },
      ],
      connectedUsers: new Set(["human-3"]),
    });

    await fixture.manager.processTurn({
      sessionId: "session-1",
      fromParticipantId: "human-1",
      content: "hello",
      mentionedIds: [],
    });

    expect(fixture.notifications).toEqual<NotificationRecord[]>([
      {
        userId: "human-2",
        companyId: "company-1",
        type: "unread_message",
        payload: {
          sessionId: "session-1",
          channelId: "channel-1",
          turnId: "turn-1",
        },
      },
    ]);
  });

  it("enqueues chunk work when token window is crossed", async () => {
    const fixture = createFixture({ tokensSinceLastChunk: CHAT_DEFAULTS.T_WINDOW });

    await fixture.manager.processTurn({
      sessionId: "session-1",
      fromParticipantId: "human-1",
      content: "substantial message",
      mentionedIds: [],
    });

    expect(fixture.chunkQueue.enqueue).toHaveBeenCalledWith("session-1");
  });

  it("broadcasts decision events for decision turns", async () => {
    const fixture = createFixture({
      turn: {
        ...makeTurn(),
        isDecision: true,
      },
    });

    await fixture.manager.processTurn({
      sessionId: "session-1",
      fromParticipantId: "human-1",
      content: "[DECISION] Ship it",
      mentionedIds: [],
    });

    expect(fixture.hub.broadcast).toHaveBeenCalledWith("channel-1", {
      type: CHAT_EVENT_TYPES.SESSION_DECISION,
      payload: { turn: fixture.turn },
    });
  });

  it("increments idle turn counts for non-sender agents", async () => {
    const fixture = createFixture({
      agentStates: [
        makeAgentState("agent-1"),
        makeAgentState("agent-2"),
      ],
    });

    await fixture.manager.processTurn({
      sessionId: "session-1",
      fromParticipantId: "agent-1",
      content: "status update",
      mentionedIds: [],
    });

    expect(fixture.repository.incrementIdleTurnCount).toHaveBeenCalledWith("session-1", ["agent-2"]);
  });

  it("fails when the session does not exist", async () => {
    const fixture = createFixture({ session: null });

    await expect(
      fixture.manager.processTurn({
        sessionId: "missing",
        fromParticipantId: "human-1",
        content: "hello",
        mentionedIds: [],
      }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

function createFixture(overrides: Partial<FixtureOptions> = {}) {
  const session = overrides.session === undefined ? makeSession() : overrides.session;
  const turn = overrides.turn ?? makeTurn();
  const participants = overrides.participants ?? [
    { participantId: "human-1", participantType: "human", companyId: "company-1" },
    { participantId: "agent-1", participantType: "agent", companyId: "company-1" },
  ];
  const agentStates = overrides.agentStates ?? [makeAgentState("agent-1")];
  const connectedUsers = overrides.connectedUsers ?? new Set<string>();
  const notifications: NotificationRecord[] = [];

  const trunkManager = {
    insertTurn: vi.fn().mockResolvedValue(turn),
  };
  const repository = {
    createSession: vi.fn().mockResolvedValue(session ?? makeSession()),
    closeSession: vi.fn().mockResolvedValue(session),
    getSession: vi.fn().mockResolvedValue(session),
    getTokensSinceLastChunk: vi.fn().mockResolvedValue(overrides.tokensSinceLastChunk ?? 0),
    listTurns: vi.fn().mockResolvedValue([turn]),
    listChannelParticipants: vi.fn().mockResolvedValue(participants),
    listSessionParticipants: vi.fn().mockResolvedValue(participants),
    listAgentStates: vi.fn().mockResolvedValue(agentStates),
    createAgentStates: vi.fn().mockResolvedValue(undefined),
    incrementIdleTurnCount: vi.fn().mockResolvedValue(undefined),
  };
  const hub = {
    broadcast: vi.fn(),
    isUserConnected: vi.fn((userId: string) => connectedUsers.has(userId)),
  };
  const notificationsRepo = {
    create: vi.fn(async (notification: NotificationRecord) => {
      notifications.push(notification);
    }),
  };
  const debounce = {
    enqueue: vi.fn(),
  };
  const chunkQueue = {
    enqueue: vi.fn(),
  };
  const paperclipClient = {
    getAgent: vi.fn(async (agentId: string) => {
      if (participants.some((participant) => participant.participantId === agentId && participant.participantType === "agent")) {
        return { id: agentId, name: `Agent ${agentId}`, bootstrapPrompt: null };
      }

      throw new Error("agent not found");
    }),
  };

  return {
    manager: new SessionManager(trunkManager, repository, hub, notificationsRepo, debounce, chunkQueue, paperclipClient),
    trunkManager,
    repository,
    hub,
    notifications,
    debounce,
    chunkQueue,
    turn,
    paperclipClient,
  };
}

function makeSession(): ChatSession {
  return {
    id: "session-1",
    channelId: "channel-1",
    status: "active",
    chunkWindowWTokens: CHAT_DEFAULTS.T_WINDOW,
    verbatimKTokens: CHAT_DEFAULTS.K_TOKENS,
    currentSeq: 1,
  };
}

function makeTurn(): Turn {
  return {
    id: "turn-1",
    sessionId: "session-1",
    seq: 1,
    fromParticipantId: "human-1",
    content: "hello",
    tokenCount: 4,
    summarize: true,
    mentionedIds: null,
    isDecision: false,
    createdAt: new Date("2026-03-21T00:00:00.000Z").toISOString(),
  };
}

function makeAgentState(participantId: string): AgentChannelState {
  return {
    id: `state-${participantId}`,
    sessionId: "session-1",
    participantId,
    status: "absent",
    anchorSeq: 0,
    cliSessionId: null,
    cliSessionPath: null,
    idleTurnCount: 0,
    tokensThisSession: 0,
  };
}

interface FixtureOptions {
  session: ChatSession | null;
  turn: Turn;
  participants: SessionParticipant[];
  agentStates: AgentChannelState[];
  connectedUsers: Set<string>;
  tokensSinceLastChunk: number;
}
