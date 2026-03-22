import type {
  AGENT_CHANNEL_STATUSES,
  CHANNEL_PARTICIPANT_TYPES,
  CHANNEL_TYPES,
  CHAT_PRESENCE,
  NOTIFICATION_TYPES,
  SESSION_STATUSES,
} from "../constants.js";

export type ChannelType = (typeof CHANNEL_TYPES)[number];
export type ChannelParticipantType = (typeof CHANNEL_PARTICIPANT_TYPES)[number];
export type AgentChannelStatus = (typeof AGENT_CHANNEL_STATUSES)[number];
export type ChatPresence = (typeof CHAT_PRESENCE)[number];
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface Channel {
  id: string;
  type: ChannelType;
  companyId: string;
  paperclipRefId: string | null;
  name: string;
}

export interface ChannelParticipant {
  id: string;
  channelId: string;
  participantType: ChannelParticipantType;
  participantId: string;
  joinedAt: string;
}

export interface SessionParticipant {
  participantId: string;
  participantType: ChannelParticipantType;
  companyId: string;
}

export interface ChatSession {
  id: string;
  channelId: string;
  status: SessionStatus;
  chunkWindowWTokens: number;
  verbatimKTokens: number;
  currentSeq: number;
}

export interface Turn {
  id: string;
  sessionId: string;
  seq: number;
  fromParticipantId: string;
  content: string;
  tokenCount: number;
  summarize: boolean;
  mentionedIds: string[] | null;
  isDecision: boolean;
  createdAt: string;
}

export interface TrunkChunk {
  id: string;
  sessionId: string;
  chunkStart: number;
  chunkEnd: number;
  summary: string;
  summaryTokenCount: number;
  inputTokenCount: number;
  dirty: boolean;
}

export interface SessionSummary {
  sessionId: string;
  text: string;
  tokenCount: number;
  chunkSeqCovered: number;
  updatedAt: string;
}

export interface AgentChannelState {
  id: string;
  sessionId: string;
  participantId: string;
  status: AgentChannelStatus;
  anchorSeq: number;
  cliSessionId: string | null;
  cliSessionPath: string | null;
  idleTurnCount: number;
  tokensThisSession: number;
}

export interface Notification {
  id: string;
  userId: string;
  companyId: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}
