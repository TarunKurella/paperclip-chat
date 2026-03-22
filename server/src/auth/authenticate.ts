import { timingSafeEqual } from "node:crypto";
import type { PaperclipClient } from "../adapters/paperclipClient.js";
import { validateAgent, type AgentAuthRequest } from "./validateAgent.js";
import { validateHuman, type HumanAuthRequest } from "./validateHuman.js";

export type Principal =
  | { type: "human"; id: string; companyId: string }
  | { type: "agent"; id: string; companyId?: string; sessionId?: string }
  | { type: "service"; id: string; companyId?: string };

export interface AuthenticatedRequest extends HumanAuthRequest, AgentAuthRequest {
  principal?: Principal;
}

export interface AuthenticatedResponse {
  status(code: number): AuthenticatedResponse;
  json(body: unknown): unknown;
}

export type NextFunction = () => unknown | Promise<unknown>;

export async function authenticate(
  req: AuthenticatedRequest,
  res: AuthenticatedResponse,
  next: NextFunction,
  paperclipClient: Pick<PaperclipClient, "validateSession" | "validateAgentJwt">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  if (hasHumanCredentials(req)) {
    const humanHandled = await attemptHuman(req, res, next, paperclipClient);
    if (humanHandled !== null) {
      return humanHandled;
    }
  }

  const bearerToken = readBearerToken(req.headers?.authorization);
  if (bearerToken && isServiceToken(bearerToken, env.CHAT_SERVICE_KEY)) {
    req.principal = { type: "service", id: "paperclip-chat-server" };
    return next();
  }

  if (bearerToken) {
    const agentHandled = await attemptAgent(req, res, next, paperclipClient, env);
    if (agentHandled !== null) {
      return agentHandled;
    }
  }

  if (shouldAllowLocalDevHuman(req, env)) {
    req.principal = {
      type: "human",
      id: env.CHAT_LOCAL_USER_ID?.trim() || "local-operator",
      companyId: env.CHAT_LOCAL_COMPANY_ID!.trim(),
    };
    return next();
  }

  return res.status(401).json({ error: "Not authenticated" });
}

export function requireAny(req: AuthenticatedRequest, res: AuthenticatedResponse, next: NextFunction): unknown {
  if (!req.principal) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  return next();
}

export function requireHuman(req: AuthenticatedRequest, res: AuthenticatedResponse, next: NextFunction): unknown {
  if (req.principal?.type !== "human") {
    return res.status(401).json({ error: "Human authentication required" });
  }

  return next();
}

export function requireService(req: AuthenticatedRequest, res: AuthenticatedResponse, next: NextFunction): unknown {
  if (req.principal?.type !== "service") {
    return res.status(401).json({ error: "Service authentication required" });
  }

  return next();
}

async function attemptHuman(
  req: AuthenticatedRequest,
  res: AuthenticatedResponse,
  next: NextFunction,
  paperclipClient: Pick<PaperclipClient, "validateSession">,
): Promise<unknown> {
  let advanced = false;
  const result = await validateHuman(
    req,
    createPassthroughResponse(res),
    async () => {
      advanced = true;
      req.principal = { type: "human", id: req.userId!, companyId: req.companyId! };
      return next();
    },
    paperclipClient,
  );

  return advanced ? result : null;
}

async function attemptAgent(
  req: AuthenticatedRequest,
  res: AuthenticatedResponse,
  next: NextFunction,
  paperclipClient: Pick<PaperclipClient, "validateAgentJwt">,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  let advanced = false;
  const result = await validateAgent(
    req,
    createPassthroughResponse(res),
    async () => {
      advanced = true;
      req.principal = { type: "agent", id: req.agentId!, ...(req.companyId ? { companyId: req.companyId } : {}), ...(req.sessionId ? { sessionId: req.sessionId } : {}) };
      return next();
    },
    paperclipClient,
    env,
  );

  return advanced ? result : null;
}

function hasHumanCredentials(req: AuthenticatedRequest): boolean {
  return Boolean(req.cookies?.["paperclip-session"] || req.headers?.cookie?.includes("paperclip-session="));
}

function readBearerToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function isServiceToken(token: string, configuredSecret: string | undefined): boolean {
  if (!configuredSecret) {
    return false;
  }

  const left = Buffer.from(token);
  const right = Buffer.from(configuredSecret);
  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

function createPassthroughResponse(res: AuthenticatedResponse): AuthenticatedResponse {
  return {
    status: () => res,
    json: () => null,
  };
}

function shouldAllowLocalDevHuman(req: AuthenticatedRequest, env: NodeJS.ProcessEnv): boolean {
  if (env.CHAT_LOCAL_DEV_AUTH !== "true") {
    return false;
  }

  const companyId = env.CHAT_LOCAL_COMPANY_ID?.trim();
  if (!companyId) {
    return false;
  }

  const host = req.headers?.host ?? "";
  const origin = req.headers?.origin ?? "";
  const localhostRequest =
    host.includes("127.0.0.1") ||
    host.includes("localhost") ||
    origin.includes("127.0.0.1") ||
    origin.includes("localhost");

  return localhostRequest;
}
