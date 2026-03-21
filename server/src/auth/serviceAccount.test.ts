import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ServiceAccountError,
  ensureServiceAccount,
  readServiceAccountEnv,
  startServiceAccountLifecycle,
  stopServiceAccountLifecycle,
} from "./serviceAccount.js";

describe("readServiceAccountEnv", () => {
  it("requires CHAT_SERVICE_KEY", () => {
    expect(() => readServiceAccountEnv({ PAPERCLIP_API_URL: "http://localhost:3100" })).toThrow(ServiceAccountError);
  });

  it("requires PAPERCLIP_API_URL", () => {
    expect(() => readServiceAccountEnv({ CHAT_SERVICE_KEY: "secret" })).toThrow("PAPERCLIP_API_URL required");
  });
});

describe("service account lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reuses an existing paperclip-chat service account", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([{ id: "company-1" }]))
      .mockResolvedValueOnce(jsonResponse([{ id: "svc-1", name: "paperclip-chat-server" }]));

    const result = await ensureServiceAccount(
      { paperclipApiUrl: "http://localhost:3100", chatServiceKey: "secret" },
      fetchMock,
    );

    expect(result.name).toBe("paperclip-chat-server");
    expect(result.companyId).toBe("company-1");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      new URL("/api/companies", "http://localhost:3100"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret" }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL("/api/companies/company-1/agents", "http://localhost:3100"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret" }) }),
    );
  });

  it("registers the paperclip-chat service account when absent", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([{ id: "company-1" }]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([{ id: "company-1" }]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ id: "svc-1", name: "paperclip-chat-server" }, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse([{ id: "company-1" }]))
      .mockResolvedValueOnce(jsonResponse([{ id: "svc-1", name: "paperclip-chat-server" }]));

    const result = await ensureServiceAccount(
      { paperclipApiUrl: "http://localhost:3100", chatServiceKey: "secret" },
      fetchMock,
    );

    expect(result.name).toBe("paperclip-chat-server");
    expect(result.companyId).toBe("company-1");
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      new URL("/api/companies/company-1/agents", "http://localhost:3100"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "paperclip-chat-server",
          adapterType: "http",
          role: "general",
          adapterConfig: {},
        }),
      }),
    );
  });

  it("starts a recurring health check after validation", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([{ id: "company-1" }]))
      .mockResolvedValueOnce(jsonResponse([{ id: "svc-1", name: "paperclip-chat-server" }]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ id: "key-1", token: "pcp_live" }, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse([{ id: "company-1" }]))
      .mockResolvedValueOnce(jsonResponse([{ id: "svc-1", name: "paperclip-chat-server" }]));

    const logger = { info: vi.fn(), warn: vi.fn() };
    const lifecycle = await startServiceAccountLifecycle(
      { paperclipApiUrl: "http://localhost:3100", chatServiceKey: "secret" },
      fetchMock,
      logger,
    );

    await vi.advanceTimersByTimeAsync(60_000);
    stopServiceAccountLifecycle(lifecycle);

    expect(logger.info).toHaveBeenCalledWith("Service account validated: paperclip-chat-server");
    expect(lifecycle.serviceAccount?.liveEventsToken).toBe("pcp_live");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}
