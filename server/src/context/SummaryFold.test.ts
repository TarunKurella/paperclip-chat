import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@paperclip-chat/shared";
import { SummaryFold } from "./SummaryFold.js";
import type { ContextStore } from "./store.js";

describe("SummaryFold", () => {
  it("upserts a session summary and emits a session.summary event", async () => {
    const store = createStore();
    const hub = { broadcast: vi.fn() };
    const fold = new SummaryFold(
      store,
      { summarize: vi.fn().mockResolvedValue("Folded summary") },
      hub,
    );

    const summary = await fold.fold("session-1");

    expect(summary?.text).toBe("Folded summary");
    expect(hub.broadcast).toHaveBeenCalledWith("channel-1", {
      type: "session.summary",
      payload: {
        sessionId: "session-1",
        text: "Folded summary",
        tokenCount: expect.any(Number),
      },
    });
  });

  it("folds DM turns directly without requiring chunks", async () => {
    const store = createStore();
    const hub = { broadcast: vi.fn() };
    const fold = new SummaryFold(
      store,
      { summarize: vi.fn().mockResolvedValue("DM folded summary") },
      hub,
    );

    const summary = await fold.foldTurns("session-1");

    expect(summary?.text).toBe("DM folded summary");
    expect(store.listTurnsForRange).toHaveBeenCalledWith("session-1", {
      fromSeq: 1,
      toSeq: 4,
      summarizeOnly: true,
    });
  });
});

function createStore(): ContextStore {
  const session = {
    id: "session-1",
    channelId: "channel-1",
    status: "active" as const,
    chunkWindowWTokens: 1200,
    verbatimKTokens: 800,
    currentSeq: 4,
    lastCrystallizedSeq: null,
    lastCrystallizedIssueId: null,
  };
  const chunks = [
    {
      id: "chunk-1",
      sessionId: "session-1",
      chunkStart: 1,
      chunkEnd: 4,
      summary: "Chunk summary",
      summaryTokenCount: 12,
      inputTokenCount: 40,
      dirty: false,
    },
  ];
  let summary: SessionSummary | null = null;

  return {
    getSession: vi.fn().mockResolvedValue(session),
    listTurnsForRange: vi.fn().mockResolvedValue([
      {
        id: "turn-1",
        sessionId: "session-1",
        seq: 1,
        fromParticipantId: "human-1",
        content: "hello",
        tokenCount: 5,
        summarize: true,
        mentionedIds: [],
        isDecision: false,
        createdAt: new Date("2026-03-21T00:00:00.000Z").toISOString(),
      },
      {
        id: "turn-2",
        sessionId: "session-1",
        seq: 4,
        fromParticipantId: "agent-1",
        content: "working on it",
        tokenCount: 7,
        summarize: true,
        mentionedIds: [],
        isDecision: false,
        createdAt: new Date("2026-03-21T00:00:01.000Z").toISOString(),
      },
    ]),
    listChunks: vi.fn().mockResolvedValue(chunks),
    createChunk: vi.fn(),
    getSummary: vi.fn().mockImplementation(async () => summary),
    upsertSummary: vi.fn().mockImplementation(async (next) => {
      summary = next;
      return next;
    }),
  };
}
