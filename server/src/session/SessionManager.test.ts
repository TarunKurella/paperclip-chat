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
      fromParticipantType: "human",
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

  it("lists session participants", async () => {
    const fixture = createFixture({
      participants: [
        { participantId: "human-1", participantType: "human", companyId: "company-1" },
        { participantId: "agent-1", participantType: "agent", companyId: "company-1" },
      ],
    });

    const participants = await fixture.manager.listSessionParticipants("session-1");

    expect(participants).toEqual([
      { participantId: "human-1", participantType: "human", companyId: "company-1" },
      { participantId: "agent-1", participantType: "agent", companyId: "company-1" },
    ]);
    expect(fixture.repository.listSessionParticipants).toHaveBeenCalledWith("session-1");
  });

  it("recovers active sessions with their agent state", async () => {
    const fixture = createFixture({
      sessions: [
        makeSession(),
        {
          ...makeSession(),
          id: "session-2",
          channelId: "channel-2",
        },
      ],
    });

    const recovered = await fixture.manager.recoverActiveSessions();

    expect(recovered).toEqual([
      { session: fixture.sessions[0], agentStates: fixture.agentStates },
      { session: fixture.sessions[1], agentStates: fixture.agentStates },
    ]);
    expect(fixture.repository.listActiveSessions).toHaveBeenCalledOnce();
  });

  it("closes a session and emits a session.closed event", async () => {
    const fixture = createFixture();

    const result = await fixture.manager.closeSession("session-1");

    expect(result.session.id).toBe("session-1");
    expect(fixture.repository.closeSession).toHaveBeenCalledWith("session-1");
    expect(fixture.hub.broadcast).toHaveBeenCalledWith("channel-1", {
      type: CHAT_EVENT_TYPES.SESSION_CLOSED,
      payload: { sessionId: "session-1" },
    });
  });

  it("crystallizes a session into a Paperclip issue and writes para-memory", async () => {
    const fixture = createFixture({
      participants: [
        { participantId: "human-1", participantType: "human", companyId: "company-1" },
        { participantId: "agent-1", participantType: "agent", companyId: "company-1" },
      ],
      turns: [
        makeTurn(),
        {
          ...makeTurn(),
          id: "turn-2",
          seq: 2,
          fromParticipantId: "agent-1",
          content: "[DECISION] Ship the rollout",
          isDecision: true,
        },
      ],
    });

    const result = await fixture.manager.closeSession({ sessionId: "session-1", crystallize: true });

    expect(fixture.paperclipClient.createIssue).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: expect.stringContaining("[CHAT]"),
        description: expect.stringContaining("[DECISION] Ship the rollout"),
      }),
    );
    expect(fixture.paraMemoryWriter.write).toHaveBeenCalledWith(
      ["agent-1"],
      "session-1",
      expect.stringContaining("Participants:"),
    );
    expect(result.paperclipIssueId).toBe("issue-1");
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
      fromParticipantType: "human",
      content: "hello",
      mentionedIds: [],
    });

    expect(fixture.notifications).toHaveLength(1);
    expect(fixture.notifications[0]).toMatchObject<Partial<NotificationRecord>>({
      userId: "human-2",
      companyId: "company-1",
      type: "unread_message",
      payload: {
        sessionId: "session-1",
        channelId: "channel-1",
        turnId: "turn-1",
      },
    });
  });

  it("enqueues chunk work when token window is crossed", async () => {
    const fixture = createFixture({ tokensSinceLastChunk: CHAT_DEFAULTS.T_WINDOW });

    await fixture.manager.processTurn({
      sessionId: "session-1",
      fromParticipantId: "human-1",
      fromParticipantType: "human",
      content: "substantial message",
      mentionedIds: [],
    });

    expect(fixture.chunkQueue.enqueue).toHaveBeenCalledWith("session-1", "group");
  });

  it("uses DM fold cadence instead of chunking for direct messages", async () => {
    const fixture = createFixture({
      channel: { id: "channel-1", type: "dm", companyId: "company-1", paperclipRefId: null, name: "Direct chat" },
      turn: {
        ...makeTurn(),
        seq: CHAT_DEFAULTS.W_DM,
      },
      tokensSinceLastChunk: CHAT_DEFAULTS.T_WINDOW,
    });

    await fixture.manager.processTurn({
      sessionId: "session-1",
      fromParticipantId: "human-1",
      fromParticipantType: "human",
      content: "direct follow up",
      mentionedIds: ["agent-1"],
    });

    expect(fixture.chunkQueue.enqueue).toHaveBeenCalledWith("session-1", "dm");
    expect(fixture.debounce.enqueue).not.toHaveBeenCalled();
    expect(fixture.repository.incrementIdleTurnCount).not.toHaveBeenCalled();
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
      fromParticipantType: "human",
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
      fromParticipantType: "agent",
      content: "status update",
      mentionedIds: [],
    });

    expect(fixture.repository.incrementIdleTurnCount).toHaveBeenCalledWith("session-1", ["agent-2"]);
  });

  it("skips agent state creation when opening a DM session", async () => {
    const fixture = createFixture({
      channel: { id: "channel-1", type: "dm", companyId: "company-1", paperclipRefId: null, name: "Direct chat" },
      participants: [
        { participantId: "human-1", participantType: "human", companyId: "company-1" },
        { participantId: "agent-1", participantType: "agent", companyId: "company-1" },
      ],
    });

    await fixture.manager.openSession({
      channelId: "channel-1",
      participantIds: ["human-1", "agent-1"],
    });

    expect(fixture.repository.createAgentStates).not.toHaveBeenCalled();
  });

  it("emits agent initiated chat event and notifications on the first agent turn", async () => {
    const fixture = createFixture({
      participants: [
        { participantId: "human-1", participantType: "human", companyId: "company-1" },
        { participantId: "human-2", participantType: "human", companyId: "company-1" },
        { participantId: "agent-1", participantType: "agent", companyId: "company-1" },
      ],
      turn: {
        ...makeTurn(),
        seq: 1,
        fromParticipantId: "agent-1",
        content: "taskId:TASK-9 I need help on rollout",
      },
    });

    await fixture.manager.processTurn({
      sessionId: "session-1",
      fromParticipantId: "agent-1",
      fromParticipantType: "agent",
      content: "taskId:TASK-9 I need help on rollout",
      mentionedIds: [],
    });

    expect(fixture.hub.broadcast).toHaveBeenCalledWith("channel-1", {
      type: CHAT_EVENT_TYPES.AGENT_INITIATED_CHAT,
      payload: {
        agentId: "agent-1",
        channelId: "channel-1",
        messagePreview: "taskId:TASK-9 I need help on rollout",
        taskId: "TASK-9",
      },
    });
    expect(fixture.notifications.filter((item) => item.type === "agent_initiated")).toHaveLength(2);
  });

  it("fails when the session does not exist", async () => {
    const fixture = createFixture({ session: null });

    await expect(
      fixture.manager.processTurn({
        sessionId: "missing",
        fromParticipantId: "human-1",
        fromParticipantType: "human",
        content: "hello",
        mentionedIds: [],
      }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

function createFixture(overrides: Partial<FixtureOptions> = {}) {
  const session = overrides.session === undefined ? makeSession() : overrides.session;
  const turn = overrides.turn ?? makeTurn();
  const turns = overrides.turns ?? [turn];
  const participants = overrides.participants ?? [
    { participantId: "human-1", participantType: "human", companyId: "company-1" },
    { participantId: "agent-1", participantType: "agent", companyId: "company-1" },
  ];
  const agentStates = overrides.agentStates ?? [makeAgentState("agent-1")];
  const connectedUsers = overrides.connectedUsers ?? new Set<string>();
  const notifications: NotificationRecord[] = [];
  const channel = overrides.channel ?? {
    id: "channel-1",
    type: "project" as const,
    companyId: "company-1",
    paperclipRefId: "project-1",
    name: "Project One",
  };

  const trunkManager = {
    insertTurn: vi.fn().mockResolvedValue(turn),
  };
  const repository = {
    createSession: vi.fn().mockResolvedValue(session ?? makeSession()),
    closeSession: vi.fn().mockResolvedValue(session),
    getSession: vi.fn().mockResolvedValue(session),
    listActiveSessions: vi.fn().mockResolvedValue(overrides.sessions ?? (session ? [session] : [])),
    getTokensSinceLastChunk: vi.fn().mockResolvedValue(overrides.tokensSinceLastChunk ?? 0),
    listTurns: vi.fn().mockResolvedValue(turns),
    listChannelParticipants: vi.fn().mockResolvedValue(participants),
    listSessionParticipants: vi.fn().mockResolvedValue(participants),
    listAgentStates: vi.fn().mockResolvedValue(agentStates),
    createAgentStates: vi.fn().mockResolvedValue(undefined),
    incrementIdleTurnCount: vi.fn().mockResolvedValue(undefined),
    saveAgentState: vi.fn().mockResolvedValue(undefined),
    saveScaffoldIssue: vi.fn().mockResolvedValue(undefined),
    saveRunState: vi.fn().mockResolvedValue(undefined),
  };
  const hub = {
    broadcast: vi.fn(),
    broadcastToUser: vi.fn(),
    isUserConnected: vi.fn((userId: string) => connectedUsers.has(userId)),
  };
  const notificationsRepo = {
    create: vi.fn(async (notification: NotificationRecord) => {
      const created = {
        id: notification.id ?? "notification-1",
        userId: notification.userId,
        companyId: notification.companyId,
        type: notification.type,
        payload: notification.payload,
        readAt: null,
        createdAt: new Date("2026-03-21T00:00:00.000Z").toISOString(),
      };
      notifications.push(created);
      return created;
    }),
    listUnread: vi.fn().mockResolvedValue(notifications),
    markRead: vi.fn().mockResolvedValue(undefined),
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
    createIssue: vi.fn().mockResolvedValue({ id: "issue-1" }),
  };
  const paraMemoryWriter = {
    write: vi.fn().mockResolvedValue(undefined),
  };
  const channels = {
    getChannel: vi.fn().mockResolvedValue(channel),
  };

  return {
    manager: new SessionManager(trunkManager, repository, hub, notificationsRepo, debounce, chunkQueue, paperclipClient, paraMemoryWriter, channels),
    trunkManager,
    repository,
    hub,
    notifications,
    debounce,
    chunkQueue,
    turn,
    turns,
    paperclipClient,
    paraMemoryWriter,
    sessions: overrides.sessions ?? (session ? [session] : []),
    agentStates,
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
    scaffoldIssueId: null,
    cliSessionId: null,
    cliSessionPath: null,
    idleTurnCount: 0,
    tokensThisSession: 0,
  };
}

interface FixtureOptions {
  session: ChatSession | null;
  turn: Turn;
  turns: Turn[];
  channel: { id: string; type: "company_general" | "project" | "dm" | "task_thread"; companyId: string; paperclipRefId: string | null; name: string };
  participants: SessionParticipant[];
  agentStates: AgentChannelState[];
  connectedUsers: Set<string>;
  tokensSinceLastChunk: number;
  sessions: ChatSession[];
}
