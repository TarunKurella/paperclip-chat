import { CHAT_DEFAULTS, CHAT_EVENT_TYPES, type AgentChannelState, type ChatSession, type Turn } from "@paperclip-chat/shared";
import type { TrunkManager } from "../context/TrunkManager.js";
import type { PaperclipClient } from "../adapters/paperclipClient.js";

export interface NotificationRecord {
  userId: string;
  companyId: string;
  type: "unread_message" | "agent_initiated" | "decision_pending";
  payload: Record<string, unknown>;
}

export interface SessionParticipant {
  participantId: string;
  participantType: "human" | "agent";
  companyId: string;
}

export interface SessionRepository {
  createSession(channelId: string): Promise<ChatSession>;
  closeSession(sessionId: string): Promise<ChatSession | null>;
  getSession(sessionId: string): Promise<ChatSession | null>;
  getTokensSinceLastChunk(sessionId: string): Promise<number>;
  listParticipants(channelId: string): Promise<SessionParticipant[]>;
  listAgentStates(sessionId: string): Promise<AgentChannelState[]>;
  createAgentStates(sessionId: string, participantIds: string[]): Promise<void>;
  incrementIdleTurnCount(sessionId: string, participantIds: string[]): Promise<void>;
}

export interface NotificationRepository {
  create(notification: NotificationRecord): Promise<void>;
}

export interface SessionHub {
  broadcast(channelId: string, event: { type: string; payload: unknown }): void;
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
  content: string;
  mentionedIds: string[];
}

export interface OpenSessionInput {
  channelId: string;
  participantIds: string[];
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
    const session = await this.repository.createSession(input.channelId);
    const participants = await this.repository.listParticipants(input.channelId);

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

    const participants = await this.repository.listParticipants(session.channelId);
    await this.notifyOfflineHumans(participants, session, turn, input.fromParticipantId);

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
        this.notifications.create({
          userId: participant.participantId,
          companyId: participant.companyId,
          type: "unread_message",
          payload: {
            sessionId: session.id,
            channelId: session.channelId,
            turnId: turn.id,
          },
        }),
      ),
    );
  }
}
