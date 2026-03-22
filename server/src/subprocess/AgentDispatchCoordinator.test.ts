import { describe, expect, it, vi } from "vitest";
import type { AgentChannelState, Channel, ChatSession, Turn } from "@paperclip-chat/shared";
import { AgentDispatchCoordinator } from "./AgentDispatchCoordinator.js";

describe("AgentDispatchCoordinator", () => {
  it("routes http agents through the wakeup manager", async () => {
    const fixture = createFixture({
      adapterType: "http",
    });

    await fixture.coordinator.flush("agent-1", "session-1", [makeTurn()]);

    expect(fixture.wakeupManager.flushMentionBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        sessionId: "session-1",
      }),
    );
    expect(fixture.subprocessManager.run).not.toHaveBeenCalled();
  });

  it("passes persisted cli session ids into subprocess dispatch", async () => {
    const fixture = createFixture({
      agentState: makeAgentState({ cliSessionId: "resume-123" }),
    });

    await fixture.coordinator.flush("agent-1", "session-1", [makeTurn()]);

    expect(fixture.subprocessManager.run).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        sessionId: "session-1",
        cliSessionId: "resume-123",
        adapterType: "claude_local",
      }),
    );
  });

  it("retries queued subprocess work when presence flushes", async () => {
    const fixture = createFixture();
    fixture.subprocessManager.run
      .mockResolvedValueOnce({ status: "queued" })
      .mockResolvedValueOnce({ status: "completed" });

    await fixture.coordinator.flush("agent-1", "session-1", [makeTurn()]);
    await fixture.coordinator.flushPending("agent-1");

    expect(fixture.subprocessManager.run).toHaveBeenCalledTimes(2);
  });

  it("injects stored summaries and chunks for observing agents", async () => {
    const fixture = createFixture({
      channel: makeChannel({ type: "project", name: "Project Alpha", paperclipRefId: "project-1" }),
      session: makeSession({ currentSeq: 12 }),
      agentState: makeAgentState({ status: "observing", anchorSeq: 0 }),
    });

    await fixture.coordinator.flush("agent-1", "session-1", [makeTurn()]);

    const prompt = fixture.subprocessManager.run.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain("[CHUNK 1-2]");
    expect(prompt).toContain("Chunk summary");
  });

  it("dispatches two-party DMs even without persisted agent state rows", async () => {
    const fixture = createFixture({
      channel: makeChannel({ type: "dm", name: "tester" }),
      participants: [
        { participantId: "human-1", participantType: "human", companyId: "company-1" },
        { participantId: "agent-1", participantType: "agent", companyId: "company-1" },
      ],
      agentStates: [],
    });

    await fixture.coordinator.flush("agent-1", "session-1", [makeTurn()]);

    expect(fixture.subprocessManager.run).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        sessionId: "session-1",
        adapterType: "claude_local",
      }),
    );
  });
});

function createFixture(overrides: {
  adapterType?: string;
  agentState?: AgentChannelState;
  channel?: Channel;
  session?: ChatSession;
  participants?: Array<{ participantId: string; participantType: "human" | "agent"; companyId: string }>;
  agentStates?: AgentChannelState[];
} = {}) {
  const session = overrides.session ?? makeSession();
  const channel = overrides.channel ?? makeChannel();
  const agentState = overrides.agentState ?? makeAgentState();
  const participants = overrides.participants ?? [
    { participantId: "human-1", participantType: "human" as const, companyId: "company-1" },
    { participantId: "agent-1", participantType: "agent" as const, companyId: "company-1" },
  ];
  const agentStates = overrides.agentStates ?? [agentState];
  const sessions = {
    getSession: vi.fn().mockResolvedValue(session as ChatSession),
    listSessionParticipants: vi.fn().mockResolvedValue(participants),
    listAgentStates: vi.fn().mockResolvedValue(agentStates),
    listTurns: vi.fn().mockResolvedValue([makeTurn()]),
  };
  const channels = {
    getChannel: vi.fn().mockResolvedValue(channel as Channel),
  };
  const context = {
    listChunks: vi.fn().mockResolvedValue([
      {
        id: "chunk-1",
        sessionId: "session-1",
        chunkStart: 1,
        chunkEnd: 2,
        summary: "Chunk summary",
        summaryTokenCount: 10,
        inputTokenCount: 20,
        dirty: false,
      },
    ]),
    getSummary: vi.fn().mockResolvedValue({
      sessionId: "session-1",
      text: "Global summary",
      tokenCount: 15,
      chunkSeqCovered: 2,
      updatedAt: new Date().toISOString(),
    }),
  };
  const paperclipClient = {
    getAgent: vi.fn().mockResolvedValue({
      id: "agent-1",
      name: "Agent One",
      adapterType: overrides.adapterType ?? "claude_local",
      bootstrapPrompt: "You are agent one",
    }),
  };
  const subprocessManager = {
    run: vi.fn().mockResolvedValue({ status: "completed" }),
  };
  const wakeupManager = {
    flushMentionBatch: vi.fn().mockResolvedValue(true),
  };

  return {
    coordinator: new AgentDispatchCoordinator(
      sessions as never,
      context as never,
      channels as never,
      paperclipClient as never,
      subprocessManager as never,
      wakeupManager as never,
    ),
    subprocessManager,
    wakeupManager,
  };
}

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "session-1",
    channelId: "channel-1",
    status: "active",
    chunkWindowWTokens: 1200,
    verbatimKTokens: 800,
    currentSeq: 3,
    ...overrides,
  };
}

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "channel-1",
    type: "dm",
    companyId: "company-1",
    paperclipRefId: null,
    name: "Direct chat",
    ...overrides,
  };
}

function makeTurn(): Turn {
  return {
    id: "turn-1",
    sessionId: "session-1",
    seq: 3,
    fromParticipantId: "human-1",
    content: "hello",
    tokenCount: 8,
    summarize: true,
    mentionedIds: ["agent-1"],
    isDecision: false,
    createdAt: "2026-03-21T00:00:00.000Z",
  };
}

function makeAgentState(overrides: Partial<AgentChannelState> = {}): AgentChannelState {
  return {
    id: "state-1",
    sessionId: "session-1",
    participantId: "agent-1",
    status: "observing",
    anchorSeq: 1,
    scaffoldIssueId: null,
    cliSessionId: null,
    cliSessionPath: null,
    idleTurnCount: 0,
    tokensThisSession: 0,
    ...overrides,
  };
}
