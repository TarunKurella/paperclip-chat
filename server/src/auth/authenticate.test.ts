import type { AuthenticatedRequest } from "./authenticate.js";
import { describe, expect, it, vi } from "vitest";
import { authenticate, requireAny, requireHuman, requireService } from "./authenticate.js";
import { signChatToken } from "./chatTokens.js";

describe("authenticate", () => {
  it("authenticates a human principal from the Paperclip session cookie", async () => {
    const req: AuthenticatedRequest = {
      cookies: { "paperclip-session": "session-cookie" },
    };
    const res = createResponse();
    const next = vi.fn();

    await authenticate(
      req,
      res,
      next,
      {
        validateSession: vi.fn().mockResolvedValue({ userId: "user-1", companyId: "company-1" }),
        validateAgentJwt: vi.fn(),
      },
      { CHAT_TOKEN_SECRET: "secret", CHAT_SERVICE_KEY: "service-secret" },
    );

    expect(next).toHaveBeenCalledOnce();
    expect(req.principal).toEqual({ type: "human", id: "user-1", companyId: "company-1" });
  });

  it("authenticates an agent principal from CHAT_API_TOKEN", async () => {
    const token = signChatToken(
      { agentId: "agent-1", sessionId: "session-1", companyId: "company-1" },
      { CHAT_TOKEN_SECRET: "secret" },
    );
    const req: AuthenticatedRequest = {
      headers: { authorization: `Bearer ${token}` },
    };
    const res = createResponse();
    const next = vi.fn();

    await authenticate(
      req,
      res,
      next,
      {
        validateSession: vi.fn(),
        validateAgentJwt: vi.fn(),
      },
      { CHAT_TOKEN_SECRET: "secret", CHAT_SERVICE_KEY: "service-secret" },
    );

    expect(next).toHaveBeenCalledOnce();
    expect(req.principal).toEqual({
      type: "agent",
      id: "agent-1",
      companyId: "company-1",
      sessionId: "session-1",
    });
  });

  it("authenticates the service principal from CHAT_SERVICE_KEY", async () => {
    const req: AuthenticatedRequest = {
      headers: { authorization: "Bearer service-secret" },
    };
    const res = createResponse();
    const next = vi.fn();

    await authenticate(
      req,
      res,
      next,
      {
        validateSession: vi.fn(),
        validateAgentJwt: vi.fn(),
      },
      { CHAT_TOKEN_SECRET: "secret", CHAT_SERVICE_KEY: "service-secret" },
    );

    expect(next).toHaveBeenCalledOnce();
    expect(req.principal).toEqual({ type: "service", id: "paperclip-chat-server" });
  });

  it("returns 401 when no principal authenticates", async () => {
    const req: AuthenticatedRequest = {};
    const res = createResponse();
    const next = vi.fn();

    await authenticate(
      req,
      res,
      next,
      {
        validateSession: vi.fn(),
        validateAgentJwt: vi.fn(),
      },
      { CHAT_TOKEN_SECRET: "secret", CHAT_SERVICE_KEY: "service-secret" },
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Not authenticated" });
  });

  it("allows an opt-in local dev human fallback", async () => {
    const req: AuthenticatedRequest = {
      headers: { host: "127.0.0.1:4000" },
    };
    const res = createResponse();
    const next = vi.fn();

    await authenticate(
      req,
      res,
      next,
      {
        validateSession: vi.fn(),
        validateAgentJwt: vi.fn(),
      },
      {
        CHAT_TOKEN_SECRET: "secret",
        CHAT_SERVICE_KEY: "service-secret",
        CHAT_LOCAL_DEV_AUTH: "true",
        CHAT_LOCAL_COMPANY_ID: "company-1",
        CHAT_LOCAL_USER_ID: "local-user",
      },
    );

    expect(next).toHaveBeenCalledOnce();
    expect(req.principal).toEqual({ type: "human", id: "local-user", companyId: "company-1" });
  });
});

describe("auth guards", () => {
  it("requireHuman rejects non-human principals", () => {
    const req: AuthenticatedRequest = {
      principal: { type: "agent", id: "agent-1", companyId: "company-1" },
    };
    const res = createResponse();
    const next = vi.fn();

    requireHuman(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Human authentication required" });
  });

  it("requireAny accepts authenticated principals", () => {
    const req: AuthenticatedRequest = {
      principal: { type: "agent", id: "agent-1", companyId: "company-1" },
    };
    const res = createResponse();
    const next = vi.fn();

    requireAny(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("requireService accepts only service principals", () => {
    const req: AuthenticatedRequest = {
      principal: { type: "human", id: "user-1", companyId: "company-1" },
    };
    const res = createResponse();
    const next = vi.fn();

    requireService(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Service authentication required" });
  });
});

function createResponse() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}
