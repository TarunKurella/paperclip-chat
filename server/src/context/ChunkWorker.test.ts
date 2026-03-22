import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@paperclip-chat/shared";
import { ChunkWorker } from "./ChunkWorker.js";
import { SummaryFold } from "./SummaryFold.js";
import type { ContextStore } from "./store.js";

describe("ChunkWorker", () => {
  it("creates a chunk once the token window is crossed", async () => {
    const store = createStore();
    const fold = { fold: vi.fn().mockResolvedValue(null) } satisfies Pick<SummaryFold, "fold">;
    const worker = new ChunkWorker(
      store,
      { summarize: vi.fn().mockResolvedValue("Chunk summary") },
      fold,
    );

    const created = await worker.enqueue("session-1");

    expect(created).toBe(true);
    const chunks = await store.listChunks("session-1");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ chunkStart: 1, chunkEnd: 2, dirty: false });
    expect(fold.fold).toHaveBeenCalledWith("session-1");
  });

  it("marks chunks dirty when summarization fails", async () => {
    const store = createStore();
    const worker = new ChunkWorker(
      store,
      { summarize: vi.fn().mockRejectedValue(new Error("boom")) },
      { fold: vi.fn() },
    );

    const created = await worker.enqueue("session-1");

    expect(created).toBe(false);
    const chunks = await store.listChunks("session-1");
    expect(chunks[0]).toMatchObject({ dirty: true, summary: "" });
  });
});

function createStore(): ContextStore {
  const session = {
    id: "session-1",
    channelId: "channel-1",
    status: "active" as const,
    chunkWindowWTokens: 10,
    verbatimKTokens: 8,
    currentSeq: 2,
  };
  const turns = [
    {
      id: "turn-1",
      sessionId: "session-1",
      seq: 1,
      fromParticipantId: "human-1",
      content: "Long message one",
      tokenCount: 6,
      summarize: true,
      mentionedIds: null,
      isDecision: false,
      createdAt: new Date().toISOString(),
    },
    {
      id: "turn-2",
      sessionId: "session-1",
      seq: 2,
      fromParticipantId: "human-2",
      content: "Long message two",
      tokenCount: 6,
      summarize: true,
      mentionedIds: null,
      isDecision: false,
      createdAt: new Date().toISOString(),
    },
  ];
  const chunks: Awaited<ReturnType<ContextStore["listChunks"]>> = [];
  let summary: SessionSummary | null = null;

  return {
    getSession: vi.fn().mockResolvedValue(session),
    listTurnsForRange: vi.fn().mockImplementation(async (_sessionId, range) =>
      turns.filter((turn) => turn.seq >= range.fromSeq && turn.seq <= range.toSeq && (!range.summarizeOnly || turn.summarize)),
    ),
    listChunks: vi.fn().mockImplementation(async () => chunks),
    createChunk: vi.fn().mockImplementation(async (input) => {
      const chunk = { ...input, id: `chunk-${chunks.length + 1}` };
      chunks.push(chunk);
      return chunk;
    }),
    getSummary: vi.fn().mockImplementation(async () => summary),
    upsertSummary: vi.fn().mockImplementation(async (next) => {
      summary = next;
      return next;
    }),
  };
}
