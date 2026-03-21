import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { CHAT_DEFAULTS } from "@paperclip-chat/shared";

export interface ChatTokenInput {
  agentId: string;
  sessionId: string;
  companyId?: string;
  exp?: string | number;
}

export interface ChatTokenClaims {
  agentId: string;
  sessionId: string;
  companyId?: string;
  iat: number;
  exp: number;
  iss: "paperclip-chat";
  aud: "paperclip-chat-api";
}

export type VerifyChatTokenResult =
  | { claims: ChatTokenClaims; reason: "valid" }
  | { claims: null; reason: "expired" | "invalid" | "malformed" };

const CHAT_JWT_ALG = "HS256";
const DEFAULT_ISSUER = "paperclip-chat";
const DEFAULT_AUDIENCE = "paperclip-chat-api";

let generatedSecret: string | null = null;

export function signChatToken(input: ChatTokenInput, env: NodeJS.ProcessEnv = process.env): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: ChatTokenClaims = {
    agentId: input.agentId,
    sessionId: input.sessionId,
    ...(input.companyId ? { companyId: input.companyId } : {}),
    iat: now,
    exp: now + parseExpiryToSeconds(input.exp ?? CHAT_DEFAULTS.CHAT_TOKEN_EXPIRY),
    iss: DEFAULT_ISSUER,
    aud: DEFAULT_AUDIENCE,
  };

  const header = { alg: CHAT_JWT_ALG, typ: "JWT" };
  const signingInput = `${encodeBase64UrlJson(header)}.${encodeBase64UrlJson(claims)}`;
  const signature = signJwt(getChatTokenSecret(env), signingInput);
  return `${signingInput}.${signature}`;
}

export function verifyChatToken(token: string, env: NodeJS.ProcessEnv = process.env): VerifyChatTokenResult {
  if (!token) {
    return { claims: null, reason: "malformed" };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { claims: null, reason: "malformed" };
  }

  const [headerB64, claimsB64, signature] = parts;
  const header = parseJsonRecord(decodeBase64UrlToUtf8(headerB64));
  const claimsRecord = parseJsonRecord(decodeBase64UrlToUtf8(claimsB64));

  if (!header || !claimsRecord || header.alg !== CHAT_JWT_ALG) {
    return { claims: null, reason: "malformed" };
  }

  if (!looksLikeChatTokenClaims(claimsRecord)) {
    return { claims: null, reason: "malformed" };
  }

  const signingInput = `${headerB64}.${claimsB64}`;
  const expectedSignature = signJwt(getChatTokenSecret(env), signingInput);
  if (!safeCompare(signature, expectedSignature)) {
    return { claims: null, reason: "invalid" };
  }

  const claims: ChatTokenClaims = {
    agentId: claimsRecord.agentId as string,
    sessionId: claimsRecord.sessionId as string,
    ...(typeof claimsRecord.companyId === "string" ? { companyId: claimsRecord.companyId } : {}),
    iat: claimsRecord.iat as number,
    exp: claimsRecord.exp as number,
    iss: claimsRecord.iss as "paperclip-chat",
    aud: claimsRecord.aud as "paperclip-chat-api",
  };
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) {
    return { claims: null, reason: "expired" };
  }

  if (claims.iss !== DEFAULT_ISSUER || claims.aud !== DEFAULT_AUDIENCE) {
    return { claims: null, reason: "invalid" };
  }

  return { claims, reason: "valid" };
}

function parseExpiryToSeconds(value: string | number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value !== "string") {
    throw new Error(`Unsupported chat token expiry: ${String(value)}`);
  }

  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+)([smhd])$/i);
  if (!match) {
    throw new Error(`Unsupported chat token expiry: ${value}`);
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier =
    unit === "s" ? 1 :
    unit === "m" ? 60 :
    unit === "h" ? 60 * 60 :
    60 * 60 * 24;
  return amount * multiplier;
}

function getChatTokenSecret(env: NodeJS.ProcessEnv): string {
  const configured = env.CHAT_TOKEN_SECRET?.trim();
  if (configured) {
    return configured;
  }

  generatedSecret ??= randomBytes(32).toString("base64url");
  return generatedSecret;
}

function looksLikeChatTokenClaims(value: Record<string, unknown>): boolean {
  return (
    typeof value.agentId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.iat === "number" &&
    typeof value.exp === "number" &&
    typeof value.iss === "string" &&
    typeof value.aud === "string" &&
    (value.companyId === undefined || typeof value.companyId === "string")
  );
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeBase64UrlToUtf8(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signJwt(secret: string, signingInput: string): string {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
