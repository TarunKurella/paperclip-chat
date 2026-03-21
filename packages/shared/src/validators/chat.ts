import { z } from "zod";
import {
  AGENT_CHANNEL_STATUSES,
  CHANNEL_PARTICIPANT_TYPES,
  CHANNEL_TYPES,
  NOTIFICATION_TYPES,
  SESSION_STATUSES,
} from "../constants.js";

export const uuidSchema = z.string().uuid();

export const channelTypeSchema = z.enum(CHANNEL_TYPES);
export const channelParticipantTypeSchema = z.enum(CHANNEL_PARTICIPANT_TYPES);
export const sessionStatusSchema = z.enum(SESSION_STATUSES);
export const agentChannelStatusSchema = z.enum(AGENT_CHANNEL_STATUSES);
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);

export const sendMessageSchema = z.object({
  text: z.string().trim().min(1).max(10000),
  mentionedIds: z.array(uuidSchema).max(32).optional(),
  summarize: z.boolean().optional(),
});

export const openSessionSchema = z.object({
  channelId: uuidSchema,
  participantIds: z.array(uuidSchema).min(1),
});

export const closeSessionSchema = z.object({
  crystallize: z.boolean().optional().default(false),
});

export const createChannelSchema = z.object({
  type: channelTypeSchema,
  companyId: uuidSchema,
  name: z.string().trim().min(1).max(255),
  paperclipRefId: z.string().trim().min(1).max(255).optional(),
  participants: z
    .array(
      z.object({
        participantType: channelParticipantTypeSchema,
        participantId: uuidSchema,
      }),
    )
    .optional()
    .default([]),
});

export const listChannelsQuerySchema = z.object({
  companyId: uuidSchema,
});

export type SendMessage = z.infer<typeof sendMessageSchema>;
export type OpenSession = z.infer<typeof openSessionSchema>;
export type CloseSession = z.infer<typeof closeSessionSchema>;
export type CreateChannel = z.infer<typeof createChannelSchema>;
export type ListChannelsQuery = z.infer<typeof listChannelsQuerySchema>;
