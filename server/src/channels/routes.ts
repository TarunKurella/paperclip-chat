import { Router, type RequestHandler, type Router as ExpressRouter } from "express";
import { createChannelSchema, listChannelsQuerySchema } from "@paperclip-chat/shared";
import type { ChannelService } from "./service.js";

export interface ChannelRouteAuth {
  authenticate?: RequestHandler;
  requireAny?: RequestHandler;
  requireHumanOrService?: RequestHandler;
}

const passThrough: RequestHandler = (_req, _res, next) => next();

export function channelRoutes(
  channelService: Pick<ChannelService, "listChannels" | "createChannel">,
  auth: ChannelRouteAuth = {},
): ExpressRouter {
  const router = Router();

  router.get("/channels", auth.authenticate ?? passThrough, auth.requireAny ?? passThrough, async (req, res) => {
    const { companyId } = listChannelsQuerySchema.parse(req.query);
    const channels = await channelService.listChannels(companyId);
    res.json(channels);
  });

  router.post(
    "/channels",
    auth.authenticate ?? passThrough,
    auth.requireHumanOrService ?? passThrough,
    async (req, res) => {
    const { participants: _participants, ...input } = createChannelSchema.parse(req.body);
    const channel = await channelService.createChannel(input);
    res.status(201).json(channel);
    },
  );

  return router;
}
