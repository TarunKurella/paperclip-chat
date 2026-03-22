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
});

function createFixture(overrides: {
  adapterType?: string;
  agentState?: AgentChannelState;
} = {}) {
  const session = makeSession();
  const channel = makeChannel();
  const agentState = overrides.agentState ?? makeAgentState();
  const sessions = {
    getSession: vi.fn().mockResolvedValue(session as ChatSession),
    listSessionParticipants: vi.fn().mockResolvedValue([
      { participantId: "human-1", participantType: "human", companyId: "company-1" },
      { participantId: "agent-1", participantType: "agent", companyId: "company-1" },
    ]),
    listAgentStates: vi.fn().mockResolvedValue([agentState]),
    listTurns: vi.fn().mockResolvedValue([makeTurn()]),
  };
  const channels = {
    getChannel: vi.fn().mockResolvedValue(channel as Channel),
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
      channels as never,
      paperclipClient as never,
      subprocessManager as never,
      wakeupManager as never,
    ),
    subprocessManager,
    wakeupManager,
  };
}

function makeSession(): ChatSession {
  return {
    id: "session-1",
    channelId: "channel-1",
    status: "active",
    chunkWindowWTokens: 1200,
    verbatimKTokens: 800,
    currentSeq: 3,
  };
}

function makeChannel(): Channel {
  return {
    id: "channel-1",
    type: "dm",
    companyId: "company-1",
    paperclipRefId: null,
    name: "Direct chat",
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
