import { describe, expect, it } from "vitest";
import { signChatToken, verifyChatToken } from "./chatTokens.js";

describe("chatTokens", () => {
  it("signs and verifies a chat token with the configured expiry", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signChatToken(
      { agentId: "agent-1", sessionId: "session-1", companyId: "company-1", exp: "10m" },
      { CHAT_TOKEN_SECRET: "secret" },
    );

    const result = verifyChatToken(token, { CHAT_TOKEN_SECRET: "secret" });

    expect(result.reason).toBe("valid");
    if (result.reason !== "valid") {
      return;
    }
    expect(result.claims.agentId).toBe("agent-1");
    expect(result.claims.sessionId).toBe("session-1");
    expect(result.claims.companyId).toBe("company-1");
    expect(result.claims.exp - result.claims.iat).toBe(600);
    expect(result.claims.iat).toBeGreaterThanOrEqual(now - 1);
  });

  it("marks an expired token as expired", () => {
    const token = signChatToken(
      { agentId: "agent-1", sessionId: "session-1", exp: 1 },
      { CHAT_TOKEN_SECRET: "secret" },
    );

    const realNow = Date.now;
    Date.now = () => realNow() + 2_000;

    try {
      expect(verifyChatToken(token, { CHAT_TOKEN_SECRET: "secret" })).toEqual({
        claims: null,
        reason: "expired",
      });
    } finally {
      Date.now = realNow;
    }
  });
});
