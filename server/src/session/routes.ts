import { Router, type RequestHandler, type Router as ExpressRouter } from "express";
import { closeSessionSchema, openSessionSchema, sendMessageSchema } from "@paperclip-chat/shared";
import type { AuthenticatedRequest } from "../auth/authenticate.js";
import type { SessionManager } from "./SessionManager.js";

export interface SessionRouteAuth {
  authenticate?: RequestHandler;
  requireAny?: RequestHandler;
}

const passThrough: RequestHandler = (_req, _res, next) => next();

export function sessionRoutes(
  sessionManager: Pick<SessionManager, "openSession" | "processTurn" | "closeSession">,
  auth: SessionRouteAuth = {},
): ExpressRouter {
  const router = Router();

  router.post("/sessions", auth.authenticate ?? passThrough, auth.requireAny ?? passThrough, async (req, res) => {
    const input = openSessionSchema.parse(req.body);
    const session = await sessionManager.openSession(input);
    res.status(201).json({ session });
  });

  router.post(
    "/sessions/:id/send",
    auth.authenticate ?? passThrough,
    auth.requireAny ?? passThrough,
    async (req, res) => {
      const sessionId = readParam(req.params.id);
      const { text, mentionedIds = [] } = sendMessageSchema.parse(req.body);
      const turn = await sessionManager.processTurn({
        sessionId,
        fromParticipantId: getSenderId(req as AuthenticatedRequest),
        content: text,
        mentionedIds,
      });
      res.json({ turn });
    },
  );

  router.post(
    "/sessions/:id/close",
    auth.authenticate ?? passThrough,
    auth.requireAny ?? passThrough,
    async (req, res) => {
      const sessionId = readParam(req.params.id);
      closeSessionSchema.parse(req.body ?? {});
      const session = await sessionManager.closeSession(sessionId);
      res.json({ session });
    },
  );

  return router;
}

function getSenderId(req: AuthenticatedRequest): string {
  if (!req.principal) {
    throw new Error("Authenticated principal required");
  }

  return req.principal.id;
}

function readParam(value: string | string[] | undefined): string {
  if (typeof value === "string") {
    return value;
  }

  throw new Error("Missing route parameter");
}
