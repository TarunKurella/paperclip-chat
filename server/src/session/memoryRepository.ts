import { randomUUID } from "node:crypto";
import { CHAT_DEFAULTS, type AgentChannelState, type ChatSession, type Notification, type SessionSummary, type TrunkChunk, type Turn } from "@paperclip-chat/shared";
import { incrementIdle } from "../context/AgentChannelState.js";
import type { NotificationRecord, SessionParticipant, SessionRepository } from "./SessionManager.js";
import type { TrunkStore } from "../context/TrunkManager.js";
import type { ContextStore } from "../context/store.js";

export class InMemorySessionRepository implements SessionRepository, TrunkStore, ContextStore {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly sessionParticipants = new Map<string, SessionParticipant[]>();
  private readonly channelParticipants = new Map<string, SessionParticipant[]>();
  private readonly agentStates = new Map<string, AgentChannelState[]>();
  private readonly turns = new Map<string, Turn[]>();
  private readonly chunks = new Map<string, TrunkChunk[]>();
  private readonly summaries = new Map<string, SessionSummary>();
  readonly notifications: Notification[] = [];

  seedChannelParticipants(channelId: string, participants: SessionParticipant[]): void {
    this.channelParticipants.set(channelId, participants);
  }

  async createSession(channelId: string, participants: SessionParticipant[]): Promise<ChatSession> {
    const session: ChatSession = {
      id: randomUUID(),
      channelId,
      status: "active",
      chunkWindowWTokens: CHAT_DEFAULTS.T_WINDOW,
      verbatimKTokens: CHAT_DEFAULTS.K_TOKENS,
      currentSeq: 0,
    };

    this.sessions.set(session.id, session);
    this.sessionParticipants.set(session.id, participants);
    return session;
  }

  async closeSession(sessionId: string): Promise<ChatSession | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    const closedSession = { ...session, status: "closed" as const };
    this.sessions.set(sessionId, closedSession);
    return closedSession;
  }

  async getSession(sessionId: string): Promise<ChatSession | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async listActiveSessions(): Promise<ChatSession[]> {
    return [...this.sessions.values()].filter((session) => session.status === "active");
  }

  async getTokensSinceLastChunk(sessionId: string): Promise<number> {
    return (this.turns.get(sessionId) ?? []).reduce((total, turn) => total + turn.tokenCount, 0);
  }

  async listTurns(sessionId: string, options: { cursor?: number; before?: number; limit?: number } = {}): Promise<Turn[]> {
    const { cursor, before, limit = 50 } = options;
    const turns = this.turns.get(sessionId) ?? [];
    if (before !== undefined) {
      return turns.filter((turn) => turn.seq < before).slice(-limit);
    }
    if (cursor !== undefined) {
      return turns.filter((turn) => turn.seq > cursor).slice(0, limit);
    }
    return turns.slice(-limit);
  }

  async listTurnsForRange(sessionId: string, range: { fromSeq: number; toSeq: number; summarizeOnly?: boolean }): Promise<Turn[]> {
    return (this.turns.get(sessionId) ?? []).filter(
      (turn) =>
        turn.seq >= range.fromSeq &&
        turn.seq <= range.toSeq &&
        (!range.summarizeOnly || turn.summarize),
    );
  }

  async listChannelParticipants(channelId: string): Promise<SessionParticipant[]> {
    return [...(this.channelParticipants.get(channelId) ?? [])];
  }

  async listSessionParticipants(sessionId: string): Promise<SessionParticipant[]> {
    return [...(this.sessionParticipants.get(sessionId) ?? [])];
  }

  async syncChannelParticipants(channelId: string, participants: SessionParticipant[]): Promise<void> {
    this.channelParticipants.set(channelId, [...participants]);
  }

  async getSessionSummary(sessionId: string): Promise<SessionSummary | null> {
    return this.summaries.get(sessionId) ?? null;
  }

  async listAgentStates(sessionId: string): Promise<AgentChannelState[]> {
    return [...(this.agentStates.get(sessionId) ?? [])];
  }

  async createAgentStates(sessionId: string, participantIds: string[]): Promise<void> {
    const existingStates = this.agentStates.get(sessionId) ?? [];
    const nextStates = participantIds.map<AgentChannelState>((participantId) => ({
      id: randomUUID(),
      sessionId,
      participantId,
      status: "absent",
      anchorSeq: 0,
      scaffoldIssueId: null,
      cliSessionId: null,
      cliSessionPath: null,
      idleTurnCount: 0,
      tokensThisSession: 0,
    }));

    this.agentStates.set(sessionId, [...existingStates, ...nextStates]);
  }

  async incrementIdleTurnCount(sessionId: string, participantIds: string[]): Promise<void> {
    const states = this.agentStates.get(sessionId) ?? [];
    const participantSet = new Set(participantIds);
    const updated = incrementIdle(
      states.filter((state) => participantSet.has(state.participantId)),
      "__none__",
    );
    const byParticipant = new Map(updated.map((state) => [state.participantId, state]));
    this.agentStates.set(sessionId, states.map((state) => byParticipant.get(state.participantId) ?? state));
  }

  async saveAgentState(state: AgentChannelState): Promise<void> {
    const states = this.agentStates.get(state.sessionId) ?? [];
    this.agentStates.set(
      state.sessionId,
      states.map((current) => (current.participantId === state.participantId ? { ...state } : current)),
    );
  }

  async saveScaffoldIssue(sessionId: string, participantId: string, scaffoldIssueId: string): Promise<void> {
    const states = this.agentStates.get(sessionId) ?? [];
    this.agentStates.set(
      sessionId,
      states.map((state) =>
        state.participantId === participantId
          ? {
              ...state,
              scaffoldIssueId,
            }
          : state,
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
    const states = this.agentStates.get(input.sessionId) ?? [];
    this.agentStates.set(
      input.sessionId,
      states.map((state) =>
        state.participantId === input.participantId
          ? {
              ...state,
              scaffoldIssueId: state.scaffoldIssueId,
              cliSessionId: input.cliSessionId,
              cliSessionPath: input.cliSessionPath,
              anchorSeq: input.anchorSeq,
              tokensThisSession: input.tokensThisSession,
            }
          : state,
      ),
    );
  }

  async listChunks(sessionId: string): Promise<TrunkChunk[]> {
    return [...(this.chunks.get(sessionId) ?? [])];
  }

  async createChunk(input: Omit<TrunkChunk, "id">): Promise<TrunkChunk> {
    const chunk: TrunkChunk = {
      ...input,
      id: randomUUID(),
    };
    const existing = this.chunks.get(input.sessionId) ?? [];
    this.chunks.set(input.sessionId, [...existing, chunk]);
    return chunk;
  }

  async getSummary(sessionId: string): Promise<SessionSummary | null> {
    return this.summaries.get(sessionId) ?? null;
  }

  async upsertSummary(summary: SessionSummary): Promise<SessionSummary> {
    this.summaries.set(summary.sessionId, summary);
    return summary;
  }

  async create(notification: NotificationRecord): Promise<Notification> {
    const createdNotification: Notification = {
      id: notification.id ?? randomUUID(),
      userId: notification.userId,
      companyId: notification.companyId,
      type: notification.type,
      payload: notification.payload,
      readAt: notification.readAt ?? null,
      createdAt: notification.createdAt ?? new Date().toISOString(),
    };

    this.notifications.push(createdNotification);
    return createdNotification;
  }

  async listUnread(userId: string): Promise<Notification[]> {
    return this.notifications
      .filter((notification) => notification.userId === userId && notification.readAt === null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async markRead(userId: string, notificationIds?: string[]): Promise<void> {
    const notificationSet = notificationIds ? new Set(notificationIds) : null;
    for (let index = 0; index < this.notifications.length; index += 1) {
      const notification = this.notifications[index];
      if (!notification || notification.userId !== userId || notification.readAt !== null) {
        continue;
      }

      if (notificationSet && !notificationSet.has(notification.id)) {
        continue;
      }

      this.notifications[index] = {
        ...notification,
        readAt: new Date().toISOString(),
      };
    }
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
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      throw new Error(`Chat session not found: ${input.sessionId}`);
    }

    const nextSeq = session.currentSeq + 1;
    const nextSession = { ...session, currentSeq: nextSeq };
    this.sessions.set(input.sessionId, nextSession);

    const turn: Turn = {
      id: randomUUID(),
      sessionId: input.sessionId,
      seq: nextSeq,
      fromParticipantId: input.fromParticipantId,
      content: input.content,
      tokenCount: input.tokenCount,
      summarize: input.summarize,
      mentionedIds: input.mentionedIds.length > 0 ? input.mentionedIds : null,
      isDecision: input.isDecision,
      createdAt: new Date().toISOString(),
    };

    const turns = this.turns.get(input.sessionId) ?? [];
    this.turns.set(input.sessionId, [...turns, turn]);
    return turn;
  }
}
