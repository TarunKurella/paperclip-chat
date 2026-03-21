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

  it("registers and validates the paperclip-chat service account", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: "svc-1", name: "paperclip-chat-server" }))
      .mockResolvedValueOnce(jsonResponse([{ id: "svc-1", name: "paperclip-chat-server" }]));

    const result = await ensureServiceAccount(
      { paperclipApiUrl: "http://localhost:3100", chatServiceKey: "secret" },
      fetchMock,
    );

    expect(result.name).toBe("paperclip-chat-server");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      new URL("/api/agents", "http://localhost:3100"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL("/api/agents", "http://localhost:3100"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret" }) }),
    );
  });

  it("starts a recurring health check after validation", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: "svc-1", name: "paperclip-chat-server" }))
      .mockResolvedValue(jsonResponse([{ id: "svc-1", name: "paperclip-chat-server" }]));

    const logger = { info: vi.fn(), warn: vi.fn() };
    const lifecycle = await startServiceAccountLifecycle(
      { paperclipApiUrl: "http://localhost:3100", chatServiceKey: "secret" },
      fetchMock,
      logger,
    );

    await vi.advanceTimersByTimeAsync(60_000);
    stopServiceAccountLifecycle(lifecycle);

    expect(logger.info).toHaveBeenCalledWith("Service account validated: paperclip-chat-server");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}
