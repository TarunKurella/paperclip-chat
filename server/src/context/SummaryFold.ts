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

    const tokenBudget = CHAT_DEFAULTS.SUMMARY_BUDGET_GROUP;
    const text = await this.model.summarize(previous?.text ?? "", latestChunk.summary, tokenBudget);
    const summary: SessionSummary = {
      sessionId,
      text,
      tokenCount: countTokens(text),
      chunkSeqCovered: latestChunk.chunkEnd,
      updatedAt: new Date().toISOString(),
    };

    const saved = await this.store.upsertSummary(summary);
    void this.costReporter?.report({
      sessionId,
      stage: "summary_fold",
      inputTokens: (previous?.tokenCount ?? 0) + latestChunk.summaryTokenCount,
      outputTokens: saved.tokenCount,
    });
    this.hub?.broadcast(session.channelId, {
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
