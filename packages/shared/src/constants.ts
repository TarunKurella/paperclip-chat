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
