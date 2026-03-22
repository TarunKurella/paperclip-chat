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
});

function createStore(): ContextStore {
  const session = {
    id: "session-1",
    channelId: "channel-1",
    status: "active" as const,
    chunkWindowWTokens: 1200,
    verbatimKTokens: 800,
    currentSeq: 4,
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
    listTurnsForRange: vi.fn(),
    listChunks: vi.fn().mockResolvedValue(chunks),
    createChunk: vi.fn(),
    getSummary: vi.fn().mockImplementation(async () => summary),
    upsertSummary: vi.fn().mockImplementation(async (next) => {
      summary = next;
      return next;
    }),
  };
}
