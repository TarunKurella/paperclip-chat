import { Router, type RequestHandler, type Router as ExpressRouter } from "express";
import { createChannelSchema, listChannelsQuerySchema } from "@paperclip-chat/shared";
import type { ChannelService } from "./service.js";

export interface ChannelRouteAuth {
  authenticate?: RequestHandler;
  requireAny?: RequestHandler;
  requireHumanOrService?: RequestHandler;
}

export interface ChannelRouteHooks {
  onChannelCreated?: (channel: Awaited<ReturnType<ChannelService["createChannel"]>>, input: Parameters<ChannelService["createChannel"]>[0]) => Promise<void> | void;
}

const passThrough: RequestHandler = (_req, _res, next) => next();

export function channelRoutes(
  channelService: Pick<ChannelService, "listChannels" | "createChannel" | "listCompanyDirectory">,
  auth: ChannelRouteAuth = {},
  hooks: ChannelRouteHooks = {},
): ExpressRouter {
  const router = Router();

  router.get("/channels", auth.authenticate ?? passThrough, auth.requireAny ?? passThrough, async (req, res) => {
    const { companyId } = listChannelsQuerySchema.parse(req.query);
    const channels = await channelService.listChannels(companyId);
    res.json(channels);
  });

  router.get("/companies/:id/directory", auth.authenticate ?? passThrough, auth.requireAny ?? passThrough, async (req, res) => {
    const companyId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!companyId) {
      throw new Error("Missing company id");
    }

    const participants = await channelService.listCompanyDirectory(companyId);
    res.json({ participants });
  });

  router.post(
    "/channels",
    auth.authenticate ?? passThrough,
    auth.requireHumanOrService ?? passThrough,
    async (req, res) => {
    const input = createChannelSchema.parse(req.body);
    const channel = await channelService.createChannel(input);
    await hooks.onChannelCreated?.(channel, input);
    res.status(201).json(channel);
    },
  );

  return router;
}
