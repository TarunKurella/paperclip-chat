import {
  agentChannelStates,
  channelParticipants,
  chatSessions,
  notifications,
  sessionSummaries,
  turns,
} from "@paperclip-chat/db";
import type {
  AgentChannelState,
  ChatSession,
  Notification,
  SessionSummary,
  Turn,
} from "@paperclip-chat/shared";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { incrementIdle } from "../context/AgentChannelState.js";
import type {
  NotificationRecord,
  NotificationRepository,
  SessionParticipant,
  SessionRepository,
} from "./SessionManager.js";

type SessionDatabase = NodePgDatabase<Record<string, never>>;

export class DbSessionRepository implements SessionRepository, NotificationRepository {
  constructor(private readonly db: SessionDatabase) {}

  async createSession(channelId: string, _participants: SessionParticipant[]): Promise<ChatSession> {
    const row = await this.db
      .insert(chatSessions)
      .values({ channelId })
      .returning()
      .then((results) => results[0]);

    return mapSessionRow(row);
  }

  async closeSession(sessionId: string): Promise<ChatSession | null> {
    const row = await this.db
      .update(chatSessions)
      .set({ status: "closed" })
      .where(eq(chatSessions.id, sessionId))
      .returning()
      .then((results) => results[0] ?? null);

    return row ? mapSessionRow(row) : null;
  }

  async getSession(sessionId: string): Promise<ChatSession | null> {
    const row = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1)
      .then((results) => results[0] ?? null);

    return row ? mapSessionRow(row) : null;
  }

  async listActiveSessions(): Promise<ChatSession[]> {
    const rows = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.status, "active"))
      .orderBy(asc(chatSessions.id));

    return rows.map(mapSessionRow);
  }

  async getTokensSinceLastChunk(sessionId: string): Promise<number> {
    const rows = await this.db
      .select({ tokenCount: turns.tokenCount })
      .from(turns)
      .where(eq(turns.sessionId, sessionId));

    return rows.reduce((sum, row) => sum + row.tokenCount, 0);
  }

  async listTurns(sessionId: string, options: { cursor?: number; limit?: number } = {}): Promise<Turn[]> {
    const { cursor, limit = 50 } = options;
    const conditions = [eq(turns.sessionId, sessionId)];
    if (cursor !== undefined) {
      conditions.push(gt(turns.seq, cursor));
    }

    const rows = await this.db
      .select()
      .from(turns)
      .where(and(...conditions))
      .orderBy(asc(turns.seq))
      .limit(limit);

    return rows.map(mapTurnRow);
  }

  async listChannelParticipants(channelId: string): Promise<SessionParticipant[]> {
    const rows = await this.db
      .select()
      .from(channelParticipants)
      .where(eq(channelParticipants.channelId, channelId))
      .orderBy(asc(channelParticipants.joinedAt));

    return rows.map((row) => ({
      participantId: row.participantId,
      participantType: row.participantType,
      companyId: "unknown-company",
    }));
  }

  async listSessionParticipants(sessionId: string): Promise<SessionParticipant[]> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return [];
    }

    return this.listChannelParticipants(session.channelId);
  }

  async getSessionSummary(sessionId: string): Promise<SessionSummary | null> {
    const row = await this.db
      .select()
      .from(sessionSummaries)
      .where(eq(sessionSummaries.sessionId, sessionId))
      .limit(1)
      .then((results) => results[0] ?? null);

    return row
      ? {
          sessionId: row.sessionId,
          text: row.text,
          tokenCount: row.tokenCount,
          chunkSeqCovered: row.chunkSeqCovered,
          updatedAt: row.updatedAt.toISOString(),
        }
      : null;
  }

  async listAgentStates(sessionId: string): Promise<AgentChannelState[]> {
    const rows = await this.db
      .select()
      .from(agentChannelStates)
      .where(eq(agentChannelStates.sessionId, sessionId))
      .orderBy(asc(agentChannelStates.participantId));

    return rows.map(mapAgentStateRow);
  }

  async createAgentStates(sessionId: string, participantIds: string[]): Promise<void> {
    if (participantIds.length === 0) {
      return;
    }

    await this.db
      .insert(agentChannelStates)
      .values(
        participantIds.map((participantId) => ({
          sessionId,
          participantId,
          scaffoldIssueId: null,
        })),
      )
      .onConflictDoNothing();
  }

  async incrementIdleTurnCount(sessionId: string, participantIds: string[]): Promise<void> {
    if (participantIds.length === 0) {
      return;
    }

    const rows = await this.db
      .select()
      .from(agentChannelStates)
      .where(
        and(
          eq(agentChannelStates.sessionId, sessionId),
          inArray(agentChannelStates.participantId, participantIds),
        ),
      );

    const nextStates = incrementIdle(rows.map(mapAgentStateRow), "__none__");
    await Promise.all(
      nextStates.map((state) =>
        this.db
          .update(agentChannelStates)
          .set({
            status: state.status,
            idleTurnCount: state.idleTurnCount,
          })
          .where(
            and(
              eq(agentChannelStates.sessionId, state.sessionId),
              eq(agentChannelStates.participantId, state.participantId),
            ),
          ),
      ),
    );
  }

  async saveAgentState(state: AgentChannelState): Promise<void> {
    await this.db
      .update(agentChannelStates)
      .set({
        status: state.status,
        anchorSeq: state.anchorSeq,
        scaffoldIssueId: state.scaffoldIssueId,
        cliSessionId: state.cliSessionId,
        cliSessionPath: state.cliSessionPath,
        idleTurnCount: state.idleTurnCount,
        tokensThisSession: state.tokensThisSession,
      })
      .where(
        and(
          eq(agentChannelStates.sessionId, state.sessionId),
          eq(agentChannelStates.participantId, state.participantId),
        ),
      );
  }

  async saveRunState(input: {
    sessionId: string;
    participantId: string;
    cliSessionId: string | null;
    cliSessionPath: string | null;
    anchorSeq: number;
    tokensThisSession: number;
  }): Promise<void> {
    await this.db
      .update(agentChannelStates)
      .set({
        cliSessionId: input.cliSessionId,
        cliSessionPath: input.cliSessionPath,
        anchorSeq: input.anchorSeq,
        tokensThisSession: input.tokensThisSession,
      })
      .where(
        and(
          eq(agentChannelStates.sessionId, input.sessionId),
          eq(agentChannelStates.participantId, input.participantId),
        ),
      );
  }

  async saveScaffoldIssue(sessionId: string, participantId: string, scaffoldIssueId: string): Promise<void> {
    await this.db
      .update(agentChannelStates)
      .set({ scaffoldIssueId })
      .where(
        and(
          eq(agentChannelStates.sessionId, sessionId),
          eq(agentChannelStates.participantId, participantId),
        ),
      );
  }

  async create(notification: NotificationRecord): Promise<Notification> {
    const row = await this.db
      .insert(notifications)
      .values({
        userId: notification.userId,
        companyId: notification.companyId,
        type: notification.type,
        payload: notification.payload,
        readAt: notification.readAt ? new Date(notification.readAt) : null,
        createdAt: notification.createdAt ? new Date(notification.createdAt) : undefined,
      })
      .returning()
      .then((results) => results[0]);

    return mapNotificationRow(row);
  }

  async listUnread(userId: string): Promise<Notification[]> {
    const rows = await this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .orderBy(asc(notifications.createdAt));

    return rows.map(mapNotificationRow);
  }

  async markRead(userId: string, notificationIds?: string[]): Promise<void> {
    const baseConditions = [eq(notifications.userId, userId), isNull(notifications.readAt)];
    if (notificationIds && notificationIds.length > 0) {
      baseConditions.push(inArray(notifications.id, notificationIds));
    }

    await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(...baseConditions));
  }
}

function mapSessionRow(row: typeof chatSessions.$inferSelect): ChatSession {
  return {
    id: row.id,
    channelId: row.channelId,
    status: row.status,
    chunkWindowWTokens: row.chunkWindowWTokens,
    verbatimKTokens: row.verbatimKTokens,
    currentSeq: row.currentSeq,
  };
}

function mapTurnRow(row: typeof turns.$inferSelect): Turn {
  return {
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
  };
}

function mapAgentStateRow(row: typeof agentChannelStates.$inferSelect): AgentChannelState {
  return {
    id: row.id,
    sessionId: row.sessionId,
    participantId: row.participantId,
    status: row.status,
    anchorSeq: row.anchorSeq,
    scaffoldIssueId: row.scaffoldIssueId,
    cliSessionId: row.cliSessionId,
    cliSessionPath: row.cliSessionPath,
    idleTurnCount: row.idleTurnCount,
    tokensThisSession: row.tokensThisSession,
  };
}

function mapNotificationRow(row: typeof notifications.$inferSelect): Notification {
  return {
    id: row.id,
    userId: row.userId,
    companyId: row.companyId,
    type: row.type,
    payload: row.payload,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
