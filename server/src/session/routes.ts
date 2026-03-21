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
  sessionManager: Pick<
    SessionManager,
    "openSession" | "processTurn" | "closeSession" | "getSessionState" | "getTokenUsage" | "listMessages"
  >,
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

  router.get("/sessions/:id", auth.authenticate ?? passThrough, auth.requireAny ?? passThrough, async (req, res) => {
    const sessionId = readParam(req.params.id);
    const state = await sessionManager.getSessionState(sessionId);
    res.json(state);
  });

  router.get("/sessions/:id/tokens", auth.authenticate ?? passThrough, auth.requireAny ?? passThrough, async (req, res) => {
    const sessionId = readParam(req.params.id);
    const turns = await sessionManager.getTokenUsage(sessionId);
    res.json({ turns });
  });

  router.get(
    "/channels/:id/messages",
    auth.authenticate ?? passThrough,
    auth.requireAny ?? passThrough,
    async (req, res) => {
      const sessionId = readParam(req.query.sessionId);
      const cursor = req.query.cursor ? Number(readParam(req.query.cursor)) : undefined;
      const turns = await sessionManager.listMessages(sessionId, cursor);
      res.json({ turns });
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

function readParam(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }

  throw new Error("Missing route parameter");
}
