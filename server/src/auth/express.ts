import type { RequestHandler } from "express";
import type { PaperclipClient } from "../adapters/paperclipClient.js";
import {
  authenticate,
  requireAny,
  requireHuman,
  requireService,
  type AuthenticatedRequest,
  type AuthenticatedResponse,
} from "./authenticate.js";

export function createAuthenticateMiddleware(
  paperclipClient: Pick<PaperclipClient, "validateSession" | "validateAgentJwt">,
  env: NodeJS.ProcessEnv = process.env,
): RequestHandler {
  return async (req, res, next) => {
    await authenticate(req as AuthenticatedRequest, res as AuthenticatedResponse, next, paperclipClient, env);
  };
}

export const requireAnyMiddleware: RequestHandler = (req, res, next) => {
  requireAny(req as AuthenticatedRequest, res as AuthenticatedResponse, next);
};

export const requireHumanMiddleware: RequestHandler = (req, res, next) => {
  requireHuman(req as AuthenticatedRequest, res as AuthenticatedResponse, next);
};

export const requireServiceMiddleware: RequestHandler = (req, res, next) => {
  requireService(req as AuthenticatedRequest, res as AuthenticatedResponse, next);
};

export const requireHumanOrServiceMiddleware: RequestHandler = (req, res, next) => {
  const principal = (req as AuthenticatedRequest).principal;
  if (principal?.type === "human" || principal?.type === "service") {
    next();
    return;
  }

  res.status(401).json({ error: "Human or service authentication required" });
};
