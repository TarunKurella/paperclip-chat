export const CHAT_DEFAULTS = {
  T_WINDOW: 1200,
  K_TOKENS: 800,
  PACKET_BUDGET: 3000,
  SUMMARY_BUDGET_DM: 500,
  SUMMARY_BUDGET_GROUP: 600,
  COALESCE_MS: 800,
  K_ACTIVE_THRESHOLD: 5,
  W_DM: 10,
  CHAT_TOKEN_EXPIRY: "10m",
} as const;

export const CHANNEL_TYPES = ["company_general", "project", "dm", "task_thread"] as const;
export const CHANNEL_PARTICIPANT_TYPES = ["human", "agent"] as const;
export const AGENT_CHANNEL_STATUSES = ["absent", "observing", "active"] as const;
export const CHAT_PRESENCE = ["available", "busy_task", "busy_dm", "offline"] as const;
export const SESSION_STATUSES = ["active", "closed"] as const;
export const NOTIFICATION_TYPES = ["agent_initiated", "unread_message", "decision_pending"] as const;

export const CHAT_EVENT_TYPES = {
  CHAT_MESSAGE: "chat.message",
  CHAT_MESSAGE_STREAM: "chat.message.stream",
  AGENT_TYPING: "agent.typing",
  AGENT_STATUS: "agent.status",
  AGENT_RUN_LOG: "agent.run.log",
  AGENT_INITIATED_CHAT: "agent.initiated_chat",
  SESSION_DECISION: "session.decision",
  SESSION_SUMMARY: "session.summary",
  SESSION_TOKENS: "session.tokens",
  SESSION_CRYSTALLIZED: "session.crystallized",
  SESSION_CLOSED: "session.closed",
  NOTIFICATION_NEW: "notification.new",
} as const;
