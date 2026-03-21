import type { Turn } from "@paperclip-chat/shared";
import { describe, expect, it } from "vitest";
import { SessionNotFoundError, TrunkManager, countTokens, shouldSummarizeTurn } from "./TrunkManager.js";

class InMemoryTrunkStore {
  private readonly sessionSeq = new Map<string, number>();

  constructor(sessionIds: string[]) {
    sessionIds.forEach((sessionId) => this.sessionSeq.set(sessionId, 0));
  }

  async insertTurnWithNextSeq(input: {
    sessionId: string;
    fromParticipantId: string;
    content: string;
    mentionedIds: string[];
    tokenCount: number;
    summarize: boolean;
    isDecision: boolean;
  }): Promise<Turn> {
    const currentSeq = this.sessionSeq.get(input.sessionId);
    if (currentSeq === undefined) {
      throw new SessionNotFoundError(input.sessionId);
    }

    const nextSeq = currentSeq + 1;
    this.sessionSeq.set(input.sessionId, nextSeq);

    return {
      id: `turn-${nextSeq}`,
      sessionId: input.sessionId,
      seq: nextSeq,
      fromParticipantId: input.fromParticipantId,
      content: input.content,
      tokenCount: input.tokenCount,
      summarize: input.summarize,
      mentionedIds: input.mentionedIds.length > 0 ? input.mentionedIds : null,
      isDecision: input.isDecision,
      createdAt: new Date("2026-03-21T00:00:00.000Z").toISOString(),
    };
  }
}

describe("TrunkManager", () => {
  it("inserts a turn with per-session sequence and metadata", async () => {
    const manager = new TrunkManager(new InMemoryTrunkStore(["session-1"]));

    const turn = await manager.insertTurn({
      sessionId: "session-1",
      fromParticipantId: "user-1",
      content: "Need a response from @agent",
      mentionedIds: ["agent-1"],
    });

    expect(turn.seq).toBe(1);
    expect(turn.mentionedIds).toEqual(["agent-1"]);
    expect(turn.summarize).toBe(true);
    expect(turn.isDecision).toBe(false);
    expect(turn.tokenCount).toBeGreaterThan(0);
  });

  it("marks decision turns from the required prefix", async () => {
    const manager = new TrunkManager(new InMemoryTrunkStore(["session-1"]));

    const turn = await manager.insertTurn({
      sessionId: "session-1",
      fromParticipantId: "user-1",
      content: "   [DECISION] Ship the hotfix today",
      mentionedIds: [],
    });

    expect(turn.isDecision).toBe(true);
    expect(turn.seq).toBe(1);
  });

  it("suppresses summarization for low-value turns", async () => {
    expect(shouldSummarizeTurn("ok")).toBe(false);
    expect(shouldSummarizeTurn("ty")).toBe(false);
    expect(shouldSummarizeTurn("👍")).toBe(false);
    expect(shouldSummarizeTurn("yo")).toBe(false);
    expect(shouldSummarizeTurn("please investigate this regression")).toBe(true);
  });

  it("counts tokens with the cl100k encoder", () => {
    expect(countTokens("hello world")).toBeGreaterThan(0);
  });

  it("fails when the session does not exist", async () => {
    const manager = new TrunkManager(new InMemoryTrunkStore([]));

    await expect(
      manager.insertTurn({
        sessionId: "missing-session",
        fromParticipantId: "user-1",
        content: "hello",
        mentionedIds: [],
      }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});
