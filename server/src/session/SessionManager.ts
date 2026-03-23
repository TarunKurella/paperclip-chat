import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CHAT_DEFAULTS, CHAT_EVENT_TYPES, type AgentChannelState, type Channel, type ChatSession, type Notification, type SessionSummary, type Turn } from "@paperclip-chat/shared";
import type { TrunkManager } from "../context/TrunkManager.js";
import type { PaperclipClient } from "../adapters/paperclipClient.js";
import { transitionOnMention } from "../context/AgentChannelState.js";

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
  displayName?: string | null;
  mentionLabel?: string | null;
}

export interface SessionRepository {
  createSession(channelId: string, participants: SessionParticipant[]): Promise<ChatSession>;
  closeSession(sessionId: string): Promise<ChatSession | null>;
  checkpointSession(input: {
    sessionId: string;
    lastCrystallizedSeq: number;
    lastCrystallizedIssueId: string | null;
  }): Promise<ChatSession | null>;
  getSession(sessionId: string): Promise<ChatSession | null>;
  listActiveSessions(): Promise<ChatSession[]>;
  getTokensSinceLastChunk(sessionId: string): Promise<number>;
  listTurns(sessionId: string, options?: { cursor?: number; before?: number; limit?: number }): Promise<Turn[]>;
  listChannelParticipants(channelId: string): Promise<SessionParticipant[]>;
  listSessionParticipants(sessionId: string): Promise<SessionParticipant[]>;
  syncChannelParticipants(channelId: string, participants: SessionParticipant[]): Promise<void>;
  getSessionSummary(sessionId: string): Promise<SessionSummary | null>;
  listAgentStates(sessionId: string): Promise<AgentChannelState[]>;
  createAgentStates(sessionId: string, participantIds: string[]): Promise<void>;
  incrementIdleTurnCount(sessionId: string, participantIds: string[]): Promise<void>;
  saveAgentState(state: AgentChannelState): Promise<void>;
  saveScaffoldIssue(sessionId: string, participantId: string, scaffoldIssueId: string): Promise<void>;
  saveRunState(input: {
    sessionId: string;
    participantId: string;
    cliSessionId: string | null;
    cliSessionPath: string | null;
    anchorSeq: number;
    tokensThisSession: number;
  }): Promise<void>;
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
  enqueueNow(agentId: string, sessionId: string, turn: Turn): Promise<void>;
}

export interface ChunkQueue {
  enqueue(sessionId: string, mode?: "group" | "dm"): Promise<void> | void;
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

export interface CloseSessionInput {
  sessionId: string;
  crystallize?: boolean;
}

export interface SessionDetails {
  session: ChatSession;
  agentStates: AgentChannelState[];
  summary: SessionSummary | null;
}

export interface CrystallizePreview {
  summaryText: string | null;
  decisionText: string | null;
}

export interface RecoveredSessionState {
  session: ChatSession;
  agentStates: AgentChannelState[];
}

export interface CloseSessionResult {
  session: ChatSession;
  paperclipIssueId?: string;
}

export interface ParaMemoryWriter {
  write(agentIds: string[], sessionId: string, content: string): Promise<void>;
}

export interface CrystallizePreviewGenerator {
  summarize(turns: Array<{ fromParticipantId: string; content: string }>): Promise<CrystallizePreview>;
}

export interface SessionChannelLookup {
  getChannel(channelId: string): Promise<Channel | null>;
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
    private readonly paperclipClient?: Pick<PaperclipClient, "getAgent" | "createIssue" | "listCompanyAgents">,
    private readonly paraMemoryWriter: ParaMemoryWriter = new AgentHomeParaMemoryWriter(),
    private readonly channels?: SessionChannelLookup,
    private readonly previewGenerator?: CrystallizePreviewGenerator,
  ) {}

  async openSession(input: OpenSessionInput): Promise<ChatSession> {
    const participants = await this.resolveParticipants(input.channelId, input.participantIds);
    await this.repository.syncChannelParticipants(input.channelId, participants);
    const session = await this.repository.createSession(input.channelId, participants);
    const isDmSession = await this.isDmChannel(input.channelId);

    const agentIds = participants
      .filter((participant) => participant.participantType === "agent")
      .map((participant) => participant.participantId);

    if (this.paperclipClient) {
      await Promise.all(agentIds.map((agentId) => this.paperclipClient!.getAgent(agentId)));
    }

    if (agentIds.length > 0 && !isDmSession) {
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
    const summary = await this.repository.getSessionSummary(sessionId);
    return { session, agentStates, summary };
  }

  async listSessionParticipants(sessionId: string): Promise<SessionParticipant[]> {
    const session = await this.repository.getSession(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    const channel = await this.channels?.getChannel(session.channelId);
    const participants = await this.repository.listSessionParticipants(sessionId);
    return this.enrichParticipants(participants, channel ?? null, channel?.type === "company_general" || channel?.type === "project");
  }

  async getCrystallizePreview(sessionId: string): Promise<CrystallizePreview> {
    const session = await this.repository.getSession(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    const foldedSummary = await this.repository.getSessionSummary(session.id);
    const turns = await this.repository.listTurns(session.id, { limit: 40 });
    const explicitDecision = [...turns].reverse().find((turn) => turn.isDecision)?.content ?? null;

    if ((foldedSummary?.text ?? "").trim() && explicitDecision) {
      return {
        summaryText: foldedSummary?.text ?? null,
        decisionText: explicitDecision,
      };
    }

    const generated = this.previewGenerator
      ? await this.previewGenerator.summarize(
          turns.map((turn) => ({
            fromParticipantId: turn.fromParticipantId,
            content: turn.content,
          })),
        )
      : { summaryText: null, decisionText: null };

    return {
      summaryText: foldedSummary?.text ?? generated.summaryText,
      decisionText: explicitDecision ?? generated.decisionText,
    };
  }

  async recoverActiveSessions(): Promise<RecoveredSessionState[]> {
    const sessions = await this.repository.listActiveSessions();
    const recovered = await Promise.all(
      sessions.map(async (session) => ({
        session,
        agentStates: await this.repository.listAgentStates(session.id),
      })),
    );

    return recovered;
  }

  async closeSession(input: string | CloseSessionInput): Promise<CloseSessionResult> {
    const sessionId = typeof input === "string" ? input : input.sessionId;
    const crystallize = typeof input === "string" ? false : (input.crystallize ?? false);
    const currentSession = await this.repository.getSession(sessionId);
    if (!currentSession) {
      throw new SessionNotFoundError(sessionId);
    }

    let paperclipIssueId: string | undefined;
    if (crystallize) {
      paperclipIssueId = await this.crystallizeSession(currentSession);
      const session = await this.repository.checkpointSession({
        sessionId,
        lastCrystallizedSeq: currentSession.currentSeq,
        lastCrystallizedIssueId: paperclipIssueId ?? null,
      });
      if (!session) {
        throw new SessionNotFoundError(sessionId);
      }

      this.hub.broadcast(session.channelId, {
        type: CHAT_EVENT_TYPES.SESSION_CRYSTALLIZED,
        payload: {
          sessionId: session.id,
          paperclipIssueId: paperclipIssueId ?? null,
          lastCrystallizedSeq: session.lastCrystallizedSeq,
        },
      });

      return paperclipIssueId ? { session, paperclipIssueId } : { session };
    }

    const session = await this.repository.closeSession(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    this.hub.broadcast(session.channelId, {
      type: CHAT_EVENT_TYPES.SESSION_CLOSED,
      payload: { sessionId: session.id },
    });

    return paperclipIssueId ? { session, paperclipIssueId } : { session };
  }

  async getTokenUsage(sessionId: string): Promise<Turn[]> {
    return this.listMessages(sessionId);
  }

  async listMessages(sessionId: string, options?: { cursor?: number; before?: number }): Promise<Turn[]> {
    const session = await this.repository.getSession(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    return this.repository.listTurns(sessionId, {
      cursor: options?.cursor,
      before: options?.before,
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

    const participants = await this.listSessionParticipants(input.sessionId);
    const isDmSession = await this.isDmChannel(session.channelId);
    const resolvedMentionedIds = resolveMentionedIds(input.content, participants, input.mentionedIds, input.fromParticipantId);

    const turn = await this.trunkManager.insertTurn({
      sessionId: input.sessionId,
      fromParticipantId: input.fromParticipantId,
      content: input.content,
      mentionedIds: resolvedMentionedIds,
    });

    if (isDmSession) {
      if (turn.seq % CHAT_DEFAULTS.W_DM === 0) {
        await this.chunkQueue.enqueue(input.sessionId, "dm");
      }
    } else {
      const tokensSinceLastChunk = await this.repository.getTokensSinceLastChunk(input.sessionId);
      if (tokensSinceLastChunk >= CHAT_DEFAULTS.T_WINDOW) {
        await this.chunkQueue.enqueue(input.sessionId, "group");
      }
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

      await this.notifyDecisionPendingHumans(participants, session, turn, input.fromParticipantId);
    }

    await this.notifyOfflineHumans(participants, session, turn, input.fromParticipantId);
    await this.notifyOnFirstAgentTurn(participants, session, turn, input);

    if (isDmSession) {
      const dmAgents = participants
        .filter(
          (participant) =>
            participant.participantType === "agent" && participant.participantId !== input.fromParticipantId,
        )
        .map((participant) => participant.participantId);
      for (const agentId of dmAgents) {
        await this.debounce.enqueueNow(agentId, input.sessionId, turn);
      }
      return turn;
    }

    const agentStates = await this.repository.listAgentStates(input.sessionId);
    const mentionedAgents = new Set(resolvedMentionedIds);
    const useForegroundFastPath = resolvedMentionedIds.length === 1;
    for (const state of agentStates) {
      if (!mentionedAgents.has(state.participantId)) {
        continue;
      }
      const nextState = transitionOnMention(state, turn.seq);
      if (nextState.status !== state.status || nextState.anchorSeq !== state.anchorSeq || nextState.idleTurnCount !== state.idleTurnCount) {
        await this.repository.saveAgentState(nextState);
      }
      if (useForegroundFastPath) {
        await this.debounce.enqueueNow(state.participantId, input.sessionId, turn);
      } else {
        this.debounce.enqueue(state.participantId, input.sessionId, turn);
      }
    }

    const idleParticipants = agentStates
      .map((state) => state.participantId)
      .filter((participantId) => participantId !== input.fromParticipantId);

    if (idleParticipants.length > 0) {
      await this.repository.incrementIdleTurnCount(input.sessionId, idleParticipants);
    }

    return turn;
  }

  private async isDmChannel(channelId: string): Promise<boolean> {
    if (!this.channels) {
      return false;
    }

    const channel = await this.channels.getChannel(channelId);
    return channel?.type === "dm";
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

  private async notifyDecisionPendingHumans(
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
            type: "decision_pending",
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
    const channel = await this.channels?.getChannel(channelId);
    const knownParticipants = await this.repository.listChannelParticipants(channelId);
    const enrichedKnown = await this.enrichParticipants(
      knownParticipants,
      channel ?? null,
      channel?.type === "company_general" || channel?.type === "project",
    );
    const byId = new Map(enrichedKnown.map((participant) => [participant.participantId, participant]));
    const fallbackCompanyId = channel?.companyId ?? knownParticipants[0]?.companyId ?? "unknown-company";
    const resolved = await Promise.all(
      participantIds.map(async (participantId) => {
        const knownParticipant = byId.get(participantId);
        if (knownParticipant) {
          return knownParticipant;
        }

        if (this.paperclipClient) {
          try {
            const agent = await this.paperclipClient.getAgent(participantId);
            return {
              participantId,
              participantType: "agent" as const,
              companyId: agent.companyId ?? fallbackCompanyId,
              displayName: agent.name,
              mentionLabel: slugifyMention(agent.urlKey ?? agent.name),
            };
          } catch {
            // Fall through to human classification when Paperclip has no matching agent.
          }
        }

        const displayName = formatHumanDisplayName(participantId);
        return {
          participantId,
          participantType: "human" as const,
          companyId: fallbackCompanyId,
          displayName,
          mentionLabel: slugifyMention(displayName),
        };
      }),
    );

    return dedupeParticipants([...enrichedKnown, ...resolved]);
  }

  private async enrichParticipants(
    participants: SessionParticipant[],
    channel: Channel | null,
    includeCompanyAgents: boolean,
  ): Promise<SessionParticipant[]> {
    const byId = new Map<string, SessionParticipant>();
    for (const participant of participants) {
      byId.set(participant.participantId, normalizeParticipant(participant));
    }

    if (channel?.companyId && this.paperclipClient?.listCompanyAgents) {
      const agents = await this.paperclipClient.listCompanyAgents(channel.companyId);
      for (const agent of agents) {
        if (isInternalChatAgent(agent.name, agent.urlKey)) {
          continue;
        }
        if (!includeCompanyAgents && !byId.has(agent.id)) {
          continue;
        }
        byId.set(agent.id, {
          participantId: agent.id,
          participantType: "agent",
          companyId: agent.companyId ?? channel.companyId,
          displayName: agent.name,
          mentionLabel: slugifyMention(agent.urlKey ?? agent.name),
        });
      }
    }

    return [...byId.values()].map(normalizeParticipant);
  }

  private async crystallizeSession(session: ChatSession): Promise<string | undefined> {
    const participants = await this.repository.listSessionParticipants(session.id);
    const turns = await this.repository.listTurns(session.id, { limit: 200 });
    const foldedSummary = await this.repository.getSessionSummary(session.id);
    const channel = await this.channels?.getChannel(session.channelId);
    const summary = buildCrystallizeSummary(session, channel?.name ?? null, participants, turns, foldedSummary);
    const companyId = participants[0]?.companyId;

    let paperclipIssueId: string | undefined;
    if (companyId && this.paperclipClient) {
      const issue = await this.paperclipClient.createIssue(companyId, {
        title: `[CHAT] ${channel?.name ?? session.channelId} / ${session.id.slice(0, 8)}`,
        description: summary,
      });
      paperclipIssueId = issue.id;
    }

    const agentIds = participants
      .filter((participant) => participant.participantType === "agent")
      .map((participant) => participant.participantId);
    await this.paraMemoryWriter.write(agentIds, session.id, summary);

    return paperclipIssueId;
  }
}

function resolveMentionedIds(
  content: string,
  participants: SessionParticipant[],
  explicitMentionedIds: string[],
  senderId: string,
): string[] {
  const resolved = new Set(explicitMentionedIds);
  const mentionTokens = new Set(
    [...content.matchAll(/(^|\s)@([a-z0-9][a-z0-9-]*)/gi)]
      .map((match) => match[2]?.trim().toLowerCase())
      .filter((value): value is string => Boolean(value)),
  );

  if (mentionTokens.size === 0) {
    return [...resolved];
  }

  for (const participant of participants) {
    if (participant.participantId === senderId) {
      continue;
    }
    const label = participant.mentionLabel?.trim().toLowerCase();
    if (label && mentionTokens.has(label)) {
      resolved.add(participant.participantId);
    }
  }

  return [...resolved];
}

function dedupeParticipants(participants: SessionParticipant[]): SessionParticipant[] {
  const seen = new Set<string>();
  return participants.filter((participant) => {
    if (seen.has(participant.participantId)) {
      return false;
    }
    seen.add(participant.participantId);
    return true;
  });
}

function normalizeParticipant(participant: SessionParticipant): SessionParticipant {
  const displayName = participant.displayName ?? (
    participant.participantType === "human"
      ? formatHumanDisplayName(participant.participantId)
      : participant.participantId
  );
  return {
    ...participant,
    displayName,
    mentionLabel: participant.mentionLabel ?? slugifyMention(displayName),
  };
}

function formatHumanDisplayName(participantId: string): string {
  const normalized = participantId.replace(/^local-/, "");
  const parts = normalized.split(/[-_]/g).filter(Boolean);
  if (parts.length === 0) {
    return participantId;
  }

  return parts.map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

function slugifyMention(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "participant";
}

function isInternalChatAgent(name?: string | null, urlKey?: string | null): boolean {
  return name === "paperclip-chat-server" || urlKey === "paperclip-chat-server";
}

function readTaskId(content: string): string | null {
  const explicitMatch = content.match(/\btaskId:([A-Za-z0-9_-]+)/i);
  if (explicitMatch?.[1]) {
    return explicitMatch[1];
  }

  const issueMatch = content.match(/\b(?:issue|task)[#:\s]+([A-Za-z0-9_-]+)/i);
  return issueMatch?.[1] ?? null;
}

function buildCrystallizeSummary(
  session: ChatSession,
  channelName: string | null,
  participants: SessionParticipant[],
  turns: Turn[],
  foldedSummary?: SessionSummary | null,
): string {
  const participantLabelById = new Map(
    participants.map((participant) => [
      participant.participantId,
      participant.displayName ?? participant.mentionLabel ?? participant.participantId,
    ]),
  );
  const participantLines = participants.length
    ? participants
      .map((participant) => `- ${participant.participantType}: ${participant.displayName ?? participant.participantId}`)
      .join("\n")
    : "- none";
  const decisionTurn = [...turns].reverse().find((turn) => turn.isDecision);
  const recentHumanAsk = [...turns].reverse().find((turn) => turn.fromParticipantId !== decisionTurn?.fromParticipantId);
  const recentTurns = turns.length
    ? turns
      .slice(-10)
      .map((turn) => `- ${participantLabelById.get(turn.fromParticipantId) ?? turn.fromParticipantId}: ${turn.content}`)
      .join("\n")
    : "- none";

  return [
    "# Chat Crystallization",
    "",
    "## Snapshot",
    channelName ? `- Channel: ${channelName}` : `- Channel: ${session.channelId}`,
    `- Session: ${session.id}`,
    `- Checkpoint: turn ${session.currentSeq}`,
    "",
    "## Summary",
    foldedSummary?.text || "No folded summary was available yet. This issue was crystallized from the latest live conversation and transcript excerpt.",
    "",
    "## Participants",
    participantLines,
    "",
    "## Latest Decision",
    decisionTurn?.content ?? "No explicit [DECISION] turn was captured in the chat yet.",
    "",
    "## Current Ask",
    recentHumanAsk?.content ?? "No single explicit ask was isolated from the recent turns.",
    "",
    "## Recent Transcript Excerpt",
    recentTurns,
  ].join("\n");
}

class AgentHomeParaMemoryWriter implements ParaMemoryWriter {
  async write(agentIds: string[], sessionId: string, content: string): Promise<void> {
    await Promise.all(
      agentIds.map(async (agentId) => {
        const workspaceDir = path.join(process.env.HOME ?? ".", ".paperclip", "agents", agentId, "workspace");
        await mkdir(workspaceDir, { recursive: true });
        await writeFile(path.join(workspaceDir, `${sessionId}-crystallize.md`), content, "utf8");
      }),
    );
  }
}
