import type { AgentChannelState, SessionSummary, TrunkChunk, Turn } from "@paperclip-chat/shared";
import { describe, expect, it } from "vitest";
import { assemblePacket, shouldUseDmShortcut } from "./PacketAssembler.js";

describe("PacketAssembler", () => {
  it("builds an absent-agent packet with bootstrap prompt and summary", () => {
    const result = assemblePacket({
      channelName: "general",
      channelType: "company_general",
      participantCount: 3,
      agentName: "CEO",
      senderName: "Alice",
      bootstrapPrompt: "You are the CEO agent.",
      agentState: makeState({ status: "absent", anchorSeq: 0 }),
      currentSeq: 3,
      triggeringTurn: makeTurn({ seq: 3, content: "What should we ship?" }),
      turns: [
        makeTurn({ seq: 1, content: "Status update", tokenCount: 5 }),
        makeTurn({ seq: 2, content: "Need product guidance", tokenCount: 6 }),
      ],
      chunks: [],
      globalSummary: makeSummary(),
    });

    expect(result.mode).toBe("absent");
    expect(result.text).toContain("You are the CEO agent.");
    expect(result.text).toContain("[SUMMARY]");
    expect(result.text).toContain("[Latest turn for CEO]");
    expect(result.text).toContain("From: Alice");
    expect(result.text).toContain("Content: What should we ship?");
  });

  it("builds an observing packet with chunks and no bootstrap prompt", () => {
    const result = assemblePacket({
      channelName: "project-alpha",
      channelType: "project",
      participantCount: 4,
      agentName: "Builder",
      senderName: "Bob",
      bootstrapPrompt: "ignored after first turn",
      agentState: makeState({ status: "observing", anchorSeq: 1 }),
      currentSeq: 10,
      triggeringTurn: makeTurn({ seq: 10, content: "Can you summarize the regression?" }),
      turns: [makeTurn({ seq: 9, content: "Regression details", tokenCount: 20 })],
      chunks: [
        makeChunk({ chunkStart: 2, chunkEnd: 4, summary: "Earlier context", summaryTokenCount: 200 }),
        makeChunk({ chunkStart: 5, chunkEnd: 8, summary: "Recent context", summaryTokenCount: 210 }),
      ],
      globalSummary: null,
    });

    expect(result.mode).toBe("observing");
    expect(result.text).toContain("[CHUNK 2-4]");
    expect(result.text).toContain("[CHUNK 5-8]");
    expect(result.text).not.toContain("ignored after first turn");
  });

  it("uses the hot shortcut for active agents and skips chunk sections", () => {
    const result = assemblePacket({
      channelName: "support",
      channelType: "company_general",
      participantCount: 3,
      agentName: "Helper",
      senderName: "Chris",
      agentState: makeState({ status: "observing", anchorSeq: 7 }),
      currentSeq: 9,
      triggeringTurn: makeTurn({ seq: 9, content: "Follow up please", tokenCount: 12 }),
      turns: [makeTurn({ seq: 8, content: "Earlier reply", tokenCount: 11 })],
      chunks: [makeChunk()],
      globalSummary: makeSummary(),
    });

    expect(result.mode).toBe("active");
    expect(result.usedHotShortcut).toBe(true);
    expect(result.text).not.toContain("[CHUNK");
  });

  it("drops middle chunks when the packet budget is exceeded", () => {
    const result = assemblePacket({
      channelName: "ops",
      channelType: "project",
      participantCount: 5,
      agentName: "Ops",
      senderName: "Dana",
      agentState: makeState({ status: "observing", anchorSeq: 1 }),
      currentSeq: 20,
      triggeringTurn: makeTurn({ seq: 20, content: "Need a complete recap", tokenCount: 40 }),
      turns: [makeTurn({ seq: 19, content: "Latest detail", tokenCount: 35 })],
      chunks: [
        makeChunk({ chunkStart: 2, chunkEnd: 5, summary: "first", summaryTokenCount: 1800 }),
        makeChunk({ chunkStart: 6, chunkEnd: 10, summary: "middle", summaryTokenCount: 1700 }),
        makeChunk({ chunkStart: 11, chunkEnd: 18, summary: "last", summaryTokenCount: 1600 }),
      ],
      globalSummary: makeSummary({ tokenCount: 300 }),
      packetBudget: 2500,
    });

    expect(result.text).toContain("[CHUNK 2-5]");
    expect(result.text).toContain("[CHUNK 11-18]");
    expect(result.text).not.toContain("[CHUNK 6-10]");
  });

  it("excludes chunks that overlap the verbatim tail", () => {
    const result = assemblePacket({
      channelName: "ops",
      channelType: "project",
      participantCount: 4,
      agentName: "Builder",
      senderName: "Dana",
      agentState: makeState({ status: "observing", anchorSeq: 1 }),
      currentSeq: 12,
      triggeringTurn: makeTurn({ seq: 12, content: "Please catch up", tokenCount: 10 }),
      turns: [
        makeTurn({ seq: 9, content: "turn-9", tokenCount: 40 }),
        makeTurn({ seq: 10, content: "turn-10", tokenCount: 40 }),
        makeTurn({ seq: 11, content: "turn-11", tokenCount: 40 }),
      ],
      chunks: [
        makeChunk({ chunkStart: 2, chunkEnd: 6, summary: "older context" }),
        makeChunk({ chunkStart: 7, chunkEnd: 9, summary: "overlaps tail" }),
      ],
      globalSummary: null,
      kTokens: 120,
    });

    expect(result.text).toContain("[CHUNK 2-6]");
    expect(result.text).not.toContain("[CHUNK 7-9]");
    expect(result.text).toContain("[Recent turns verbatim]");
  });

  it("detects the DM shortcut only for two-party dm channels", () => {
    expect(shouldUseDmShortcut("dm", 2)).toBe(true);
    expect(shouldUseDmShortcut("dm", 3)).toBe(false);
    expect(shouldUseDmShortcut("project", 2)).toBe(false);
  });
});

function makeState(overrides: Partial<AgentChannelState> = {}): AgentChannelState {
  return {
    id: "state-1",
    sessionId: "session-1",
    participantId: "agent-1",
    status: "observing",
    anchorSeq: 0,
    scaffoldIssueId: null,
    cliSessionId: null,
    cliSessionPath: null,
    idleTurnCount: 0,
    tokensThisSession: 0,
    ...overrides,
  };
}

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    sessionId: "session-1",
    seq: 1,
    fromParticipantId: "human-1",
    content: "hello",
    tokenCount: 10,
    summarize: true,
    mentionedIds: null,
    isDecision: false,
    createdAt: "2026-03-21T00:00:00.000Z",
    ...overrides,
  };
}

function makeChunk(overrides: Partial<TrunkChunk> = {}): TrunkChunk {
  return {
    id: "chunk-1",
    sessionId: "session-1",
    chunkStart: 1,
    chunkEnd: 2,
    summary: "summary",
    summaryTokenCount: 100,
    inputTokenCount: 200,
    dirty: false,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "session-1",
    text: "Global summary",
    tokenCount: 120,
    chunkSeqCovered: 2,
    updatedAt: "2026-03-21T00:00:00.000Z",
    ...overrides,
  };
}
