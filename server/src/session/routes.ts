import { Router, type RequestHandler, type Router as ExpressRouter } from "express";
import { closeSessionSchema, openSessionSchema, sendMessageSchema } from "@paperclip-chat/shared";
import type { AuthenticatedRequest } from "../auth/authenticate.js";
import type { SessionManager } from "./SessionManager.js";

export interface SessionRouteAuth {
  authenticate?: RequestHandler;
  requireAny?: RequestHandler;
}

export interface SessionRouteHooks {
  onSessionOpened?: (session: Awaited<ReturnType<SessionManager["openSession"]>>) => Promise<void> | void;
  onTurnProcessed?: (sessionId: string) => Promise<void> | void;
  onSessionClosed?: (sessionId: string) => Promise<void> | void;
}

export interface AgentRateLimiter {
  consume(agentId: string): boolean;
}

const passThrough: RequestHandler = (_req, _res, next) => next();

export function sessionRoutes(
  sessionManager: Pick<
    SessionManager,
    "openSession" | "processTurn" | "closeSession" | "getSessionState" | "getTokenUsage" | "listMessages" | "listSessionParticipants"
  >,
  auth: SessionRouteAuth = {},
  hooks: SessionRouteHooks = {},
  rateLimiter: AgentRateLimiter = new InMemoryAgentRateLimiter(),
): ExpressRouter {
  const router = Router();

  router.post("/sessions", auth.authenticate ?? passThrough, auth.requireAny ?? passThrough, async (req, res) => {
    const input = openSessionSchema.parse(req.body);
    const principal = (req as AuthenticatedRequest).principal;
    const participantIds = dedupeParticipantIds([
      ...input.participantIds,
      ...(principal ? [principal.id] : []),
    ]);

    if (participantIds.length === 0) {
      res.status(400).json({ error: "At least one participant is required" });
      return;
    }

    const session = await sessionManager.openSession({
      ...input,
      participantIds,
    });
    await hooks.onSessionOpened?.(session);
    res.status(201).json({ session });
  });

  router.post(
    "/sessions/:id/send",
    auth.authenticate ?? passThrough,
    auth.requireAny ?? passThrough,
    async (req, res) => {
      const sessionId = readParam(req.params.id);
      const { text, mentionedIds = [] } = sendMessageSchema.parse(req.body);
      const principal = (req as AuthenticatedRequest).principal;
      if (principal?.type === "agent" && !rateLimiter.consume(principal.id)) {
        res.status(429).json({ error: "Agent send rate limit exceeded (20 messages per minute)" });
        return;
      }

      const turn = await sessionManager.processTurn({
        sessionId,
        fromParticipantId: getSenderId(req as AuthenticatedRequest),
        fromParticipantType: principal?.type === "agent" ? "agent" : principal?.type === "human" ? "human" : "service",
        content: text,
        mentionedIds,
      });
      await hooks.onTurnProcessed?.(sessionId);
      res.json({ turn });
    },
  );

  router.post(
    "/sessions/:id/close",
    auth.authenticate ?? passThrough,
    auth.requireAny ?? passThrough,
    async (req, res) => {
      const sessionId = readParam(req.params.id);
      const { crystallize } = closeSessionSchema.parse(req.body ?? {});
      const result = await sessionManager.closeSession({ sessionId, crystallize });
      await hooks.onSessionClosed?.(sessionId);
      res.json(result);
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

  router.get("/sessions/:id/participants", auth.authenticate ?? passThrough, auth.requireAny ?? passThrough, async (req, res) => {
    const sessionId = readParam(req.params.id);
    const participants = await sessionManager.listSessionParticipants(sessionId);
    res.json({ participants });
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

class InMemoryAgentRateLimiter implements AgentRateLimiter {
  private readonly sendsByAgent = new Map<string, number[]>();

  consume(agentId: string): boolean {
    const now = Date.now();
    const windowStart = now - 60_000;
    const recent = (this.sendsByAgent.get(agentId) ?? []).filter((timestamp) => timestamp > windowStart);
    if (recent.length >= 20) {
      this.sendsByAgent.set(agentId, recent);
      return false;
    }

    recent.push(now);
    this.sendsByAgent.set(agentId, recent);
    return true;
  }
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

function dedupeParticipantIds(participantIds: string[]): string[] {
  return [...new Set(participantIds)];
}
