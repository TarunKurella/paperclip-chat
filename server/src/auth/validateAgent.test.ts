import type { AgentAuthRequest } from "./validateAgent.js";
import { describe, expect, it, vi } from "vitest";
import { signChatToken } from "./chatTokens.js";
import { validateAgent } from "./validateAgent.js";

describe("validateAgent", () => {
  it("accepts a valid CHAT_API_TOKEN", async () => {
    const req: AgentAuthRequest = {
      headers: {
        authorization: `Bearer ${signChatToken(
          { agentId: "agent-1", sessionId: "session-1", companyId: "company-1" },
          { CHAT_TOKEN_SECRET: "secret" },
        )}`,
      },
    };
    const res = createResponse();
    const next = vi.fn();

    await validateAgent(req, res, next, { validateAgentJwt: vi.fn() as never }, { CHAT_TOKEN_SECRET: "secret" });

    expect(next).toHaveBeenCalledOnce();
    expect(req.agentId).toBe("agent-1");
    expect(req.companyId).toBe("company-1");
    expect(req.sessionId).toBe("session-1");
  });

  it("falls through to Paperclip JWT validation when the chat token is expired", async () => {
    const token = signChatToken(
      { agentId: "agent-1", sessionId: "session-1", exp: 1 },
      { CHAT_TOKEN_SECRET: "secret" },
    );
    const req: AgentAuthRequest = { headers: { authorization: `Bearer ${token}` } };
    const res = createResponse();
    const next = vi.fn();
    const validateAgentJwt = vi.fn().mockResolvedValue({ id: "agent-2", companyId: "company-2" });

    const realNow = Date.now;
    Date.now = () => realNow() + 2_000;

    try {
      await validateAgent(req, res, next, { validateAgentJwt }, { CHAT_TOKEN_SECRET: "secret" });
    } finally {
      Date.now = realNow;
    }

    expect(validateAgentJwt).toHaveBeenCalledWith(token);
    expect(next).toHaveBeenCalledOnce();
    expect(req.agentId).toBe("agent-2");
    expect(req.companyId).toBe("company-2");
  });

  it("accepts a valid Paperclip agent JWT fallback", async () => {
    const req: AgentAuthRequest = { headers: { authorization: "Bearer paperclip-run-token" } };
    const res = createResponse();
    const next = vi.fn();
    const validateAgentJwt = vi.fn().mockResolvedValue({ id: "agent-3", companyId: "company-3" });

    await validateAgent(req, res, next, { validateAgentJwt }, { CHAT_TOKEN_SECRET: "secret" });

    expect(validateAgentJwt).toHaveBeenCalledWith("paperclip-run-token");
    expect(next).toHaveBeenCalledOnce();
    expect(req.agentId).toBe("agent-3");
    expect(req.companyId).toBe("company-3");
  });

  it("rejects a chat token signed with the wrong secret without forwarding to Paperclip", async () => {
    const token = signChatToken(
      { agentId: "agent-1", sessionId: "session-1" },
      { CHAT_TOKEN_SECRET: "wrong-secret" },
    );
    const req: AgentAuthRequest = { headers: { authorization: `Bearer ${token}` } };
    const res = createResponse();
    const next = vi.fn();
    const validateAgentJwt = vi.fn();

    await validateAgent(req, res, next, { validateAgentJwt }, { CHAT_TOKEN_SECRET: "secret" });

    expect(validateAgentJwt).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns 401 when both auth paths fail", async () => {
    const req: AgentAuthRequest = { headers: { authorization: "Bearer invalid-token" } };
    const res = createResponse();
    const next = vi.fn();
    const validateAgentJwt = vi.fn().mockRejectedValue(new Error("nope"));

    await validateAgent(req, res, next, { validateAgentJwt }, { CHAT_TOKEN_SECRET: "secret" });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid token" });
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
