import { chatSessions, sessionSummaries, trunkChunks, turns } from "@paperclip-chat/db";
import type { ChatSession, SessionSummary, TrunkChunk, Turn } from "@paperclip-chat/shared";
import { and, asc, eq, gt, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { InMemorySessionRepository } from "../session/memoryRepository.js";

export interface ContextStore {
  getSession(sessionId: string): Promise<ChatSession | null>;
  listTurnsForRange(sessionId: string, range: { fromSeq: number; toSeq: number; summarizeOnly?: boolean }): Promise<Turn[]>;
  listChunks(sessionId: string): Promise<TrunkChunk[]>;
  createChunk(input: Omit<TrunkChunk, "id">): Promise<TrunkChunk>;
  getSummary(sessionId: string): Promise<SessionSummary | null>;
  upsertSummary(summary: SessionSummary): Promise<SessionSummary>;
}

type ContextDatabase = NodePgDatabase<Record<string, never>>;

export function createDrizzleContextStore(db: ContextDatabase): ContextStore {
  return {
    async getSession(sessionId) {
      const row = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).limit(1).then((results) => results[0] ?? null);
      return row
        ? {
            id: row.id,
            channelId: row.channelId,
            status: row.status,
            chunkWindowWTokens: row.chunkWindowWTokens,
            verbatimKTokens: row.verbatimKTokens,
            currentSeq: row.currentSeq,
          }
        : null;
    },
    async listTurnsForRange(sessionId, range) {
      const predicates = [eq(turns.sessionId, sessionId), gt(turns.seq, range.fromSeq - 1), lte(turns.seq, range.toSeq)];
      if (range.summarizeOnly) {
        predicates.push(eq(turns.summarize, true));
      }
      const rows = await db.select().from(turns).where(and(...predicates)).orderBy(asc(turns.seq));
      return rows.map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        seq: row.seq,
        fromParticipantId: row.fromParticipantId,
        content: row.content,
        tokenCount: row.tokenCount,
        summarize: row.summarize,
        mentionedIds: row.mentionedIds,
        isDecision: row.isDecision,
        createdAt: row.createdAt.toISOString(),
      }));
    },
    async listChunks(sessionId) {
      const rows = await db.select().from(trunkChunks).where(eq(trunkChunks.sessionId, sessionId)).orderBy(asc(trunkChunks.chunkStart));
      return rows.map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        chunkStart: row.chunkStart,
        chunkEnd: row.chunkEnd,
        summary: row.summary,
        summaryTokenCount: row.summaryTokenCount,
        inputTokenCount: row.inputTokenCount,
        dirty: row.dirty,
      }));
    },
    async createChunk(input) {
      const row = await db.insert(trunkChunks).values(input).returning().then((results) => results[0]!);
      return {
        id: row.id,
        sessionId: row.sessionId,
        chunkStart: row.chunkStart,
        chunkEnd: row.chunkEnd,
        summary: row.summary,
        summaryTokenCount: row.summaryTokenCount,
        inputTokenCount: row.inputTokenCount,
        dirty: row.dirty,
      };
    },
    async getSummary(sessionId) {
      const row = await db.select().from(sessionSummaries).where(eq(sessionSummaries.sessionId, sessionId)).limit(1).then((results) => results[0] ?? null);
      return row
        ? {
            sessionId: row.sessionId,
            text: row.text,
            tokenCount: row.tokenCount,
            chunkSeqCovered: row.chunkSeqCovered,
            updatedAt: row.updatedAt.toISOString(),
          }
        : null;
    },
    async upsertSummary(summary) {
      const row = await db
        .insert(sessionSummaries)
        .values({
          sessionId: summary.sessionId,
          text: summary.text,
          tokenCount: summary.tokenCount,
          chunkSeqCovered: summary.chunkSeqCovered,
        })
        .onConflictDoUpdate({
          target: sessionSummaries.sessionId,
          set: {
            text: summary.text,
            tokenCount: summary.tokenCount,
            chunkSeqCovered: summary.chunkSeqCovered,
            updatedAt: new Date(summary.updatedAt),
          },
        })
        .returning()
        .then((results) => results[0]!);

      return {
        sessionId: row.sessionId,
        text: row.text,
        tokenCount: row.tokenCount,
        chunkSeqCovered: row.chunkSeqCovered,
        updatedAt: row.updatedAt.toISOString(),
      };
    },
  };
}

export function createInMemoryContextStore(repository: InMemorySessionRepository): ContextStore {
  return repository;
}
