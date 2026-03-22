import { CHAT_DEFAULTS, CHAT_EVENT_TYPES, type SessionSummary } from "@paperclip-chat/shared";
import { countTokens } from "./TrunkManager.js";
import type { ContextStore } from "./store.js";

export interface SummaryFoldModel {
  summarize(previousSummary: string, chunkSummary: string, tokenBudget: number): Promise<string>;
}

export interface SummaryCostReporter {
  report(event: { sessionId: string; stage: "summary_fold"; inputTokens: number; outputTokens: number }): Promise<void>;
}

export interface SummaryFoldHub {
  broadcast(channelId: string, event: { type: string; payload: unknown }): void;
}

export class SummaryFold {
  private readonly locks = new Map<string, Promise<SessionSummary | null>>();

  constructor(
    private readonly store: ContextStore,
    private readonly model: SummaryFoldModel,
    private readonly hub?: SummaryFoldHub,
    private readonly costReporter?: SummaryCostReporter,
  ) {}

  async fold(sessionId: string): Promise<SessionSummary | null> {
    const existing = this.locks.get(sessionId);
    if (existing) {
      return existing;
    }

    const task = this.doFold(sessionId).finally(() => {
      if (this.locks.get(sessionId) === task) {
        this.locks.delete(sessionId);
      }
    });
    this.locks.set(sessionId, task);
    return task;
  }

  async foldTurns(sessionId: string): Promise<SessionSummary | null> {
    const existing = this.locks.get(sessionId);
    if (existing) {
      return existing;
    }

    const task = this.doFoldTurns(sessionId).finally(() => {
      if (this.locks.get(sessionId) === task) {
        this.locks.delete(sessionId);
      }
    });
    this.locks.set(sessionId, task);
    return task;
  }

  private async doFold(sessionId: string): Promise<SessionSummary | null> {
    const session = await this.store.getSession(sessionId);
    if (!session) {
      return null;
    }

    const chunks = await this.store.listChunks(sessionId);
    const latestChunk = chunks[chunks.length - 1];
    if (!latestChunk || latestChunk.dirty) {
      return null;
    }

    const previous = await this.store.getSummary(sessionId);
    if (previous && previous.chunkSeqCovered >= latestChunk.chunkEnd) {
      return previous;
    }

    return this.foldDelta(sessionId, session.channelId, previous, latestChunk.summary, latestChunk.chunkEnd, {
      tokenBudget: CHAT_DEFAULTS.SUMMARY_BUDGET_GROUP,
      inputTokens: latestChunk.summaryTokenCount,
    });
  }

  private async doFoldTurns(sessionId: string): Promise<SessionSummary | null> {
    const session = await this.store.getSession(sessionId);
    if (!session) {
      return null;
    }

    const previous = await this.store.getSummary(sessionId);
    const fromSeq = (previous?.chunkSeqCovered ?? 0) + 1;
    if (fromSeq > session.currentSeq) {
      return previous;
    }

    const turns = await this.store.listTurnsForRange(sessionId, {
      fromSeq,
      toSeq: session.currentSeq,
      summarizeOnly: true,
    });
    if (turns.length === 0) {
      return previous;
    }

    const deltaText = turns.map((turn) => `${turn.fromParticipantId}: ${turn.content}`).join("\n");
    const inputTokens = turns.reduce((sum, turn) => sum + turn.tokenCount, 0);

    return this.foldDelta(sessionId, session.channelId, previous, deltaText, session.currentSeq, {
      tokenBudget: CHAT_DEFAULTS.SUMMARY_BUDGET_DM,
      inputTokens,
    });
  }

  private async foldDelta(
    sessionId: string,
    channelId: string,
    previous: SessionSummary | null,
    deltaText: string,
    chunkSeqCovered: number,
    options: { tokenBudget: number; inputTokens: number },
  ): Promise<SessionSummary> {
    const text = await this.model.summarize(previous?.text ?? "", deltaText, options.tokenBudget);
    const summary: SessionSummary = {
      sessionId,
      text,
      tokenCount: countTokens(text),
      chunkSeqCovered,
      updatedAt: new Date().toISOString(),
    };

    const saved = await this.store.upsertSummary(summary);
    void this.costReporter?.report({
      sessionId,
      stage: "summary_fold",
      inputTokens: (previous?.tokenCount ?? 0) + options.inputTokens,
      outputTokens: saved.tokenCount,
    });
    this.hub?.broadcast(channelId, {
      type: CHAT_EVENT_TYPES.SESSION_SUMMARY,
      payload: {
        sessionId,
        text: saved.text,
        tokenCount: saved.tokenCount,
      },
    });
    return saved;
  }
}
