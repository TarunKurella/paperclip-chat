import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const channelTypeEnum = pgEnum("channel_type", [
  "company_general",
  "project",
  "dm",
  "task_thread",
]);

export const participantTypeEnum = pgEnum("participant_type", ["human", "agent"]);
export const sessionStatusEnum = pgEnum("session_status", ["active", "closed"]);
export const agentChannelStatusEnum = pgEnum("agent_channel_status", ["absent", "observing", "active"]);
export const notificationTypeEnum = pgEnum("notification_type", [
  "agent_initiated",
  "unread_message",
  "decision_pending",
]);

export const channels = pgTable("channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: channelTypeEnum("type").notNull(),
  companyId: uuid("company_id").notNull(),
  paperclipRefId: text("paperclip_ref_id"),
  name: text("name").notNull(),
});

export const channelParticipants = pgTable("channel_participants", {
  id: uuid("id").primaryKey().defaultRandom(),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  participantType: participantTypeEnum("participant_type").notNull(),
  participantId: uuid("participant_id").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: false }).notNull().defaultNow(),
});

export const chatSessions = pgTable("chat_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  status: sessionStatusEnum("status").notNull().default("active"),
  chunkWindowWTokens: integer("chunk_window_w_tokens").notNull().default(1200),
  verbatimKTokens: integer("verbatim_k_tokens").notNull().default(800),
  currentSeq: integer("current_seq").notNull().default(0),
});

export const turns = pgTable(
  "turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    seq: integer("seq").generatedAlwaysAsIdentity(),
    fromParticipantId: uuid("from_participant_id").notNull(),
    content: text("content").notNull(),
    tokenCount: integer("token_count").notNull(),
    summarize: boolean("summarize").notNull().default(true),
    mentionedIds: text("mentioned_ids").array(),
    isDecision: boolean("is_decision").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: false }).notNull().defaultNow(),
  },
  (table) => ({
    sessionSeqIdx: index("turns_session_id_seq_idx").on(table.sessionId, table.seq),
  }),
);

export const trunkChunks = pgTable(
  "trunk_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    chunkStart: integer("chunk_start").notNull(),
    chunkEnd: integer("chunk_end").notNull(),
    summary: text("summary").notNull(),
    summaryTokenCount: integer("summary_token_count").notNull(),
    inputTokenCount: integer("input_token_count").notNull(),
    dirty: boolean("dirty").notNull().default(false),
  },
  (table) => ({
    sessionChunkRangeIdx: index("trunk_chunks_session_range_idx").on(table.sessionId, table.chunkStart, table.chunkEnd),
  }),
);

export const sessionSummaries = pgTable("session_summaries", {
  sessionId: uuid("session_id").primaryKey().references(() => chatSessions.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  tokenCount: integer("token_count").notNull(),
  chunkSeqCovered: integer("chunk_seq_covered").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: false }).notNull().defaultNow(),
});

export const agentChannelStates = pgTable(
  "agent_channel_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id").notNull(),
    status: agentChannelStatusEnum("status").notNull().default("absent"),
    anchorSeq: integer("anchor_seq").notNull().default(0),
    cliSessionId: text("cli_session_id"),
    cliSessionPath: text("cli_session_path"),
    idleTurnCount: integer("idle_turn_count").notNull().default(0),
    tokensThisSession: integer("tokens_this_session").notNull().default(0),
  },
  (table) => ({
    sessionParticipantUnique: uniqueIndex("agent_channel_states_session_participant_idx").on(
      table.sessionId,
      table.participantId,
    ),
  }),
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    companyId: uuid("company_id").notNull(),
    type: notificationTypeEnum("type").notNull(),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    readAt: timestamp("read_at", { withTimezone: false }),
    createdAt: timestamp("created_at", { withTimezone: false }).notNull().defaultNow(),
  },
  (table) => ({
    unreadByUserIdx: index("notifications_unread_by_user_idx")
      .on(table.userId, table.readAt)
      .where(sql`${table.readAt} is null`),
  }),
);

export const channelsRelations = relations(channels, ({ many }) => ({
  participants: many(channelParticipants),
  sessions: many(chatSessions),
}));

export const channelParticipantsRelations = relations(channelParticipants, ({ one }) => ({
  channel: one(channels, {
    fields: [channelParticipants.channelId],
    references: [channels.id],
  }),
}));

export const chatSessionsRelations = relations(chatSessions, ({ one, many }) => ({
  channel: one(channels, {
    fields: [chatSessions.channelId],
    references: [channels.id],
  }),
  turns: many(turns),
  chunks: many(trunkChunks),
  summary: one(sessionSummaries, {
    fields: [chatSessions.id],
    references: [sessionSummaries.sessionId],
  }),
  agentStates: many(agentChannelStates),
}));

export const turnsRelations = relations(turns, ({ one }) => ({
  session: one(chatSessions, {
    fields: [turns.sessionId],
    references: [chatSessions.id],
  }),
}));

export const trunkChunksRelations = relations(trunkChunks, ({ one }) => ({
  session: one(chatSessions, {
    fields: [trunkChunks.sessionId],
    references: [chatSessions.id],
  }),
}));

export const sessionSummariesRelations = relations(sessionSummaries, ({ one }) => ({
  session: one(chatSessions, {
    fields: [sessionSummaries.sessionId],
    references: [chatSessions.id],
  }),
}));

export const agentChannelStatesRelations = relations(agentChannelStates, ({ one }) => ({
  session: one(chatSessions, {
    fields: [agentChannelStates.sessionId],
    references: [chatSessions.id],
  }),
}));
