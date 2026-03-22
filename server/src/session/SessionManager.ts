import { CHAT_DEFAULTS, CHAT_EVENT_TYPES, type AgentChannelState, type ChatSession, type Notification, type Turn } from "@paperclip-chat/shared";
import type { TrunkManager } from "../context/TrunkManager.js";
import type { PaperclipClient } from "../adapters/paperclipClient.js";

export interface NotificationRecord {
  id?: string;
  userId: string;
  companyId: string;
  type: "unread_message" | "agent_initiated" | "decision_pending";
  payload: Record<string, unknown>;
  readAt?: string | null;
  createdAt?: string;
}

export interface SessionParticipant {
  participantId: string;
  participantType: "human" | "agent";
  companyId: string;
}

export interface SessionRepository {
  createSession(channelId: string, participants: SessionParticipant[]): Promise<ChatSession>;
  closeSession(sessionId: string): Promise<ChatSession | null>;
  getSession(sessionId: string): Promise<ChatSession | null>;
  getTokensSinceLastChunk(sessionId: string): Promise<number>;
  listTurns(sessionId: string, options?: { cursor?: number; limit?: number }): Promise<Turn[]>;
  listChannelParticipants(channelId: string): Promise<SessionParticipant[]>;
  listSessionParticipants(sessionId: string): Promise<SessionParticipant[]>;
  listAgentStates(sessionId: string): Promise<AgentChannelState[]>;
  createAgentStates(sessionId: string, participantIds: string[]): Promise<void>;
  incrementIdleTurnCount(sessionId: string, participantIds: string[]): Promise<void>;
}

export interface NotificationRepository {
  create(notification: NotificationRecord): Promise<Notification>;
  listUnread(userId: string): Promise<Notification[]>;
  markRead(userId: string, notificationIds?: string[]): Promise<void>;
}

export interface SessionHub {
  broadcast(channelId: string, event: { type: string; payload: unknown }): void;
  broadcastToUser(userId: string, event: { type: string; payload: unknown }): void;
  isUserConnected(userId: string): boolean;
}

export interface AgentWakeupQueue {
  enqueue(agentId: string, sessionId: string, turn: Turn): void;
}

export interface ChunkQueue {
  enqueue(sessionId: string): Promise<void> | void;
}

export interface ProcessTurnInput {
  sessionId: string;
  fromParticipantId: string;
  fromParticipantType?: "human" | "agent" | "service";
  content: string;
  mentionedIds: string[];
}

export interface OpenSessionInput {
  channelId: string;
  participantIds: string[];
}

export interface SessionDetails {
  session: ChatSession;
  agentStates: AgentChannelState[];
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Chat session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export class SessionManager {
  constructor(
    private readonly trunkManager: Pick<TrunkManager, "insertTurn">,
    private readonly repository: SessionRepository,
    private readonly hub: SessionHub,
    private readonly notifications: NotificationRepository,
    private readonly debounce: AgentWakeupQueue,
    private readonly chunkQueue: ChunkQueue,
    private readonly paperclipClient?: Pick<PaperclipClient, "getAgent">,
  ) {}

  async openSession(input: OpenSessionInput): Promise<ChatSession> {
    const participants = await this.resolveParticipants(input.channelId, input.participantIds);
    const session = await this.repository.createSession(input.channelId, participants);

    const agentIds = participants
      .filter(
        (participant) =>
          participant.participantType === "agent" &&
          input.participantIds.includes(participant.participantId),
      )
      .map((participant) => participant.participantId);

    if (this.paperclipClient) {
      await Promise.all(agentIds.map((agentId) => this.paperclipClient!.getAgent(agentId)));
    }

    if (agentIds.length > 0) {
      await this.repository.createAgentStates(session.id, agentIds);
    }

    return session;
  }

  async getSessionState(sessionId: string): Promise<SessionDetails> {
    const session = await this.repository.getSession(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    const agentStates = await this.repository.listAgentStates(sessionId);
    return { session, agentStates };
  }

  async closeSession(sessionId: string): Promise<ChatSession> {
    const session = await this.repository.closeSession(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    this.hub.broadcast(session.channelId, {
      type: CHAT_EVENT_TYPES.SESSION_CLOSED,
      payload: { sessionId: session.id },
    });

    return session;
  }

  async getTokenUsage(sessionId: string): Promise<Turn[]> {
    return this.listMessages(sessionId);
  }

  async listMessages(sessionId: string, cursor?: number): Promise<Turn[]> {
    const session = await this.repository.getSession(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    return this.repository.listTurns(sessionId, {
      cursor,
      limit: 50,
    });
  }

  async listNotifications(userId: string): Promise<Notification[]> {
    return this.notifications.listUnread(userId);
  }

  async markNotificationsRead(userId: string, notificationIds?: string[]): Promise<void> {
    await this.notifications.markRead(userId, notificationIds);
  }

  async processTurn(input: ProcessTurnInput): Promise<Turn> {
    const session = await this.repository.getSession(input.sessionId);
    if (!session) {
      throw new SessionNotFoundError(input.sessionId);
    }

    const turn = await this.trunkManager.insertTurn({
      sessionId: input.sessionId,
      fromParticipantId: input.fromParticipantId,
      content: input.content,
      mentionedIds: input.mentionedIds,
    });

    const tokensSinceLastChunk = await this.repository.getTokensSinceLastChunk(input.sessionId);
    if (tokensSinceLastChunk >= CHAT_DEFAULTS.T_WINDOW) {
      await this.chunkQueue.enqueue(input.sessionId);
    }

    this.hub.broadcast(session.channelId, {
      type: CHAT_EVENT_TYPES.CHAT_MESSAGE,
      payload: { turn },
    });

    if (turn.isDecision) {
      this.hub.broadcast(session.channelId, {
        type: CHAT_EVENT_TYPES.SESSION_DECISION,
        payload: { turn },
      });
    }

    const participants = await this.repository.listSessionParticipants(input.sessionId);
    await this.notifyOfflineHumans(participants, session, turn, input.fromParticipantId);
    await this.notifyOnFirstAgentTurn(participants, session, turn, input);

    const agentStates = await this.repository.listAgentStates(input.sessionId);
    const mentionedAgents = new Set(input.mentionedIds);
    for (const state of agentStates) {
      if (!mentionedAgents.has(state.participantId)) {
        continue;
      }
      this.debounce.enqueue(state.participantId, input.sessionId, turn);
    }

    const idleParticipants = agentStates
      .map((state) => state.participantId)
      .filter((participantId) => participantId !== input.fromParticipantId);

    if (idleParticipants.length > 0) {
      await this.repository.incrementIdleTurnCount(input.sessionId, idleParticipants);
    }

    return turn;
  }

  private async notifyOnFirstAgentTurn(
    participants: SessionParticipant[],
    session: ChatSession,
    turn: Turn,
    input: ProcessTurnInput,
  ): Promise<void> {
    if (input.fromParticipantType !== "agent" || turn.seq !== 1) {
      return;
    }

    const preview = turn.content.length > 160 ? `${turn.content.slice(0, 157)}...` : turn.content;
    const taskId = readTaskId(turn.content);

    this.hub.broadcast(session.channelId, {
      type: CHAT_EVENT_TYPES.AGENT_INITIATED_CHAT,
      payload: {
        agentId: input.fromParticipantId,
        channelId: session.channelId,
        messagePreview: preview,
        ...(taskId ? { taskId } : {}),
      },
    });

    const humanParticipants = participants.filter(
      (participant) => participant.participantType === "human" && participant.participantId !== input.fromParticipantId,
    );

    await Promise.all(
      humanParticipants.map((participant) =>
        this.notifications
          .create({
            userId: participant.participantId,
            companyId: participant.companyId,
            type: "agent_initiated",
            payload: {
              sessionId: session.id,
              channelId: session.channelId,
              turnId: turn.id,
              agentId: input.fromParticipantId,
              messagePreview: preview,
              ...(taskId ? { taskId } : {}),
            },
          })
          .then((notification) => {
            this.hub.broadcastToUser(participant.participantId, {
              type: CHAT_EVENT_TYPES.NOTIFICATION_NEW,
              payload: notification,
            });
          }),
      ),
    );
  }

  private async notifyOfflineHumans(
    participants: SessionParticipant[],
    session: ChatSession,
    turn: Turn,
    senderId: string,
  ): Promise<void> {
    const offlineHumans = participants.filter(
      (participant) =>
        participant.participantType === "human" &&
        participant.participantId !== senderId &&
        !this.hub.isUserConnected(participant.participantId),
    );

    await Promise.all(
      offlineHumans.map((participant) =>
        this.notifications
          .create({
            userId: participant.participantId,
            companyId: participant.companyId,
            type: "unread_message",
            payload: {
              sessionId: session.id,
              channelId: session.channelId,
              turnId: turn.id,
            },
          })
          .then((notification) => {
            this.hub.broadcastToUser(participant.participantId, {
              type: CHAT_EVENT_TYPES.NOTIFICATION_NEW,
              payload: notification,
            });
          }),
      ),
    );
  }

  private async resolveParticipants(channelId: string, participantIds: string[]): Promise<SessionParticipant[]> {
    const knownParticipants = await this.repository.listChannelParticipants(channelId);
    const byId = new Map(knownParticipants.map((participant) => [participant.participantId, participant]));
    const fallbackCompanyId = knownParticipants[0]?.companyId ?? "unknown-company";

    return Promise.all(
      participantIds.map(async (participantId) => {
        const knownParticipant = byId.get(participantId);
        if (knownParticipant) {
          return knownParticipant;
        }

        if (this.paperclipClient) {
          try {
            await this.paperclipClient.getAgent(participantId);
            return {
              participantId,
              participantType: "agent" as const,
              companyId: fallbackCompanyId,
            };
          } catch {
            // Fall through to human classification when Paperclip has no matching agent.
          }
        }

        return {
          participantId,
          participantType: "human" as const,
          companyId: fallbackCompanyId,
        };
      }),
    );
  }
}

function readTaskId(content: string): string | null {
  const explicitMatch = content.match(/\btaskId:([A-Za-z0-9_-]+)/i);
  if (explicitMatch?.[1]) {
    return explicitMatch[1];
  }

  const issueMatch = content.match(/\b(?:issue|task)[#:\s]+([A-Za-z0-9_-]+)/i);
  return issueMatch?.[1] ?? null;
}
