import type { PaperclipClient } from "../adapters/paperclipClient.js";
import { verifyChatToken } from "./chatTokens.js";

export interface AgentAuthRequest {
  headers?: Record<string, string | undefined>;
  agentId?: string;
  companyId?: string;
  sessionId?: string;
}

export interface AgentAuthResponse {
  status(code: number): AgentAuthResponse;
  json(body: unknown): unknown;
}

export type NextFunction = () => unknown | Promise<unknown>;

export async function validateAgent(
  req: AgentAuthRequest,
  res: AgentAuthResponse,
  next: NextFunction,
  paperclipClient: Pick<PaperclipClient, "validateAgentJwt">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const token = readBearerToken(req.headers?.authorization);
  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  const chatResult = verifyChatToken(token, env);
  if (chatResult.reason === "valid") {
    req.agentId = chatResult.claims.agentId;
    req.companyId = chatResult.claims.companyId;
    req.sessionId = chatResult.claims.sessionId;
    return next();
  }

  if (chatResult.reason === "invalid") {
    return res.status(401).json({ error: "Invalid token" });
  }

  try {
    const agent = await paperclipClient.validateAgentJwt(token);
    req.agentId = agent.id;
    req.companyId = agent.companyId;
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function readBearerToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}
