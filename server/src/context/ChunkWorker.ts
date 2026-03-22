import { countTokens } from "./TrunkManager.js";
import type { ContextStore } from "./store.js";
import type { SummaryFold } from "./SummaryFold.js";

export interface ChunkSummaryModel {
  summarize(turns: Array<{ fromParticipantId: string; content: string }>): Promise<string>;
}

export interface ChunkCostReporter {
  report(event: { sessionId: string; stage: "chunk"; inputTokens: number; outputTokens: number }): Promise<void>;
}

export class ChunkWorker {
  private readonly locks = new Map<string, Promise<boolean>>();

  constructor(
    private readonly store: ContextStore,
    private readonly model: ChunkSummaryModel,
    private readonly summaryFold: Pick<SummaryFold, "fold">,
    private readonly costReporter?: ChunkCostReporter,
  ) {}

  async enqueue(sessionId: string): Promise<boolean> {
    const existing = this.locks.get(sessionId);
    if (existing) {
      return existing;
    }

    const task = this.doChunk(sessionId).finally(() => {
      if (this.locks.get(sessionId) === task) {
        this.locks.delete(sessionId);
      }
    });
    this.locks.set(sessionId, task);
    return task;
  }

  private async doChunk(sessionId: string): Promise<boolean> {
    const session = await this.store.getSession(sessionId);
    if (!session) {
      return false;
    }

    const chunks = await this.store.listChunks(sessionId);
    const lastChunkEnd = chunks[chunks.length - 1]?.chunkEnd ?? 0;
    const turns = await this.store.listTurnsForRange(sessionId, {
      fromSeq: lastChunkEnd + 1,
      toSeq: session.currentSeq,
      summarizeOnly: true,
    });

    if (turns.length === 0) {
      return false;
    }

    const selected = selectChunkTurns(turns, session.chunkWindowWTokens);
    if (selected.length === 0) {
      return false;
    }

    const inputTokens = selected.reduce((sum, turn) => sum + turn.tokenCount, 0);
    if (inputTokens < session.chunkWindowWTokens) {
      return false;
    }

    try {
      const summary = await this.model.summarize(selected);
      const created = await this.store.createChunk({
        sessionId,
        chunkStart: selected[0]!.seq,
        chunkEnd: selected[selected.length - 1]!.seq,
        summary,
        summaryTokenCount: countTokens(summary),
        inputTokenCount: inputTokens,
        dirty: false,
      });
      void this.costReporter?.report({
        sessionId,
        stage: "chunk",
        inputTokens,
        outputTokens: created.summaryTokenCount,
      });
      await this.summaryFold.fold(sessionId);
      return true;
    } catch {
      await this.store.createChunk({
        sessionId,
        chunkStart: selected[0]!.seq,
        chunkEnd: selected[selected.length - 1]!.seq,
        summary: "",
        summaryTokenCount: 0,
        inputTokenCount: inputTokens,
        dirty: true,
      });
      return false;
    }
  }
}

function selectChunkTurns<TTurn extends { tokenCount: number }>(turns: TTurn[], threshold: number): TTurn[] {
  const selected: TTurn[] = [];
  let total = 0;

  for (const turn of turns) {
    selected.push(turn);
    total += turn.tokenCount;
    if (total >= threshold) {
      break;
    }
  }

  return selected;
}
