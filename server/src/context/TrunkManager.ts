import { chatSessions, turns } from "@paperclip-chat/db";
import type { Turn } from "@paperclip-chat/shared";
import { eq, sql } from "drizzle-orm";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

const lowValueMessages = new Set(["ok", "k", "+1", "thanks", "ty"]);
const singleEmojiPattern = /^\p{Emoji}$/u;
const decisionPrefix = "[DECISION]";
const encoder = getEncoding("cl100k_base");

type TrunkDatabase = NodePgDatabase<Record<string, never>>;

export interface InsertTurnInput {
  sessionId: string;
  fromParticipantId: string;
  content: string;
  mentionedIds: string[];
}

export interface TrunkStore {
  insertTurnWithNextSeq(input: PersistedTurnInput): Promise<Turn>;
}

interface PersistedTurnInput extends InsertTurnInput {
  tokenCount: number;
  summarize: boolean;
  isDecision: boolean;
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Chat session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export class TrunkManager {
  constructor(private readonly store: TrunkStore) {}

  async insertTurn(input: InsertTurnInput): Promise<Turn> {
    const trimmedContent = input.content.trim();

    return this.store.insertTurnWithNextSeq({
      ...input,
      tokenCount: countTokens(input.content),
      summarize: shouldSummarizeTurn(input.content),
      isDecision: trimmedContent.startsWith(decisionPrefix),
    });
  }
}

export function createDrizzleTrunkStore(db: TrunkDatabase): TrunkStore {
  return {
    async insertTurnWithNextSeq(input) {
      return db.transaction(async (tx) => {
        const [session] = await tx
          .update(chatSessions)
          .set({ currentSeq: sql`${chatSessions.currentSeq} + 1` })
          .where(eq(chatSessions.id, input.sessionId))
          .returning({
            currentSeq: chatSessions.currentSeq,
          });

        if (!session) {
          throw new SessionNotFoundError(input.sessionId);
        }

        const [createdTurn] = await tx
          .insert(turns)
          .values({
            sessionId: input.sessionId,
            seq: session.currentSeq,
            fromParticipantId: input.fromParticipantId,
            content: input.content,
            tokenCount: input.tokenCount,
            summarize: input.summarize,
            mentionedIds: input.mentionedIds.length > 0 ? input.mentionedIds : null,
            isDecision: input.isDecision,
          })
          .returning({
            id: turns.id,
            sessionId: turns.sessionId,
            seq: turns.seq,
            fromParticipantId: turns.fromParticipantId,
            content: turns.content,
            tokenCount: turns.tokenCount,
            summarize: turns.summarize,
            mentionedIds: turns.mentionedIds,
            isDecision: turns.isDecision,
            createdAt: turns.createdAt,
          });

        return {
          ...createdTurn,
          mentionedIds: createdTurn.mentionedIds,
          createdAt: createdTurn.createdAt.toISOString(),
        };
      });
    },
  };
}

export function countTokens(content: string, currentEncoder: Pick<Tiktoken, "encode"> = encoder): number {
  return currentEncoder.encode(content).length;
}

export function shouldSummarizeTurn(content: string): boolean {
  const trimmed = content.trim();
  const normalized = trimmed.toLowerCase();

  if (trimmed.length < 3) {
    return false;
  }

  if (lowValueMessages.has(normalized)) {
    return false;
  }

  return !singleEmojiPattern.test(trimmed);
}
