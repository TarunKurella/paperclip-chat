import type { HumanAuthRequest } from "./validateHuman.js";
import { describe, expect, it, vi } from "vitest";
import { validateHuman } from "./validateHuman.js";

describe("validateHuman", () => {
  it("sets request context for a valid Paperclip session cookie", async () => {
    const req: HumanAuthRequest = { cookies: { "paperclip-session": "session-cookie" } };
    const res = mockResponse();
    const next = vi.fn();
    const paperclipClient = {
      validateSession: vi.fn().mockResolvedValue({ userId: "user-1", companyId: "company-1" }),
    };

    await validateHuman(req, res, next, paperclipClient);

    expect(req.userId).toBe("user-1");
    expect(req.companyId).toBe("company-1");
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 401 when the cookie is missing", async () => {
    const req: HumanAuthRequest = {};
    const res = mockResponse();
    const next = vi.fn();

    await validateHuman(req, res, next, {
      validateSession: vi.fn(),
    });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Not authenticated" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when Paperclip session validation fails", async () => {
    const req: HumanAuthRequest = { headers: { cookie: "paperclip-session=bad-cookie" } };
    const res = mockResponse();
    const next = vi.fn();

    await validateHuman(req, res, next, {
      validateSession: vi.fn().mockRejectedValue(new Error("invalid session")),
    });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Not authenticated" });
    expect(next).not.toHaveBeenCalled();
  });
});

function mockResponse() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
}
