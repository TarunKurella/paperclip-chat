export const CHAT_API_PATHS = {
  CHANNELS: "/api/channels",
  CHANNEL: (id: string) => `/api/channels/${id}`,
  CHANNEL_MESSAGES: (id: string) => `/api/channels/${id}/messages`,
  CHANNEL_SUMMARY: (id: string) => `/api/channels/${id}/summary`,
  SESSIONS: "/api/sessions",
  SESSION: (id: string) => `/api/sessions/${id}`,
  SESSION_SEND: (id: string) => `/api/sessions/${id}/send`,
  SESSION_CLOSE: (id: string) => `/api/sessions/${id}/close`,
  SESSION_TOKENS: (id: string) => `/api/sessions/${id}/tokens`,
  NOTIFICATIONS: "/api/notifications",
  NOTIFICATIONS_READ: "/api/notifications/read",
  SKILL: "/api/skills/paperclip-chat",
} as const;
