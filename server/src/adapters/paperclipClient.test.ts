import { describe, expect, it, vi } from "vitest";
import { PaperclipApiError, PaperclipClient } from "./paperclipClient.js";

describe("PaperclipClient", () => {
  it("gets an agent and includes auth headers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        id: "agent-1",
        name: "Research Agent",
        adapterType: "http",
        role: "general",
      }),
    );

    const client = new PaperclipClient({
      baseUrl: "http://localhost:3100",
      serviceKey: "secret",
      fetchImpl: fetchMock,
      retryDelaysMs: [0, 0, 0],
    });

    const result = await client.getAgent("agent-1");

    expect(result.id).toBe("agent-1");
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/agents/agent-1", "http://localhost:3100"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer secret",
          "X-Paperclip-Run-Id": expect.stringMatching(/^chat-server-/),
        }),
      }),
    );
  });

  it("retries 5xx responses before succeeding", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("boom", { status: 500, statusText: "Internal Server Error" }))
      .mockResolvedValueOnce(jsonResponse({ id: "agent-1", name: "Agent" }));

    const client = new PaperclipClient({
      baseUrl: "http://localhost:3100",
      serviceKey: "secret",
      fetchImpl: fetchMock,
      retryDelaysMs: [0],
      logger: { warn: vi.fn() },
    });

    const result = await client.getAgent("agent-1");

    expect(result.id).toBe("agent-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when response validation fails", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ nope: true }));
    const client = new PaperclipClient({
      baseUrl: "http://localhost:3100",
      serviceKey: "secret",
      fetchImpl: fetchMock,
      retryDelaysMs: [0],
    });

    await expect(client.getAgent("agent-1")).rejects.toThrow();
  });

  it("throws an API error after exhausting retries", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("server down", { status: 503, statusText: "Service Unavailable" }));

    const client = new PaperclipClient({
      baseUrl: "http://localhost:3100",
      serviceKey: "secret",
      fetchImpl: fetchMock,
      retryDelaysMs: [0],
      logger: { warn: vi.fn() },
    });

    await expect(client.getAgent("agent-1")).rejects.toBeInstanceOf(PaperclipApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("validates an agent JWT against /api/agents/me without the service key", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ id: "agent-1", companyId: "company-1" }));
    const client = new PaperclipClient({
      baseUrl: "http://localhost:3100",
      serviceKey: "secret",
      fetchImpl: fetchMock,
      retryDelaysMs: [0],
    });

    const result = await client.validateAgentJwt("paperclip-run-token");

    expect(result).toEqual({ id: "agent-1", companyId: "company-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/agents/me", "http://localhost:3100"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer paperclip-run-token",
          "X-Paperclip-Run-Id": expect.stringMatching(/^chat-server-/),
        }),
      }),
    );
  });

  it("lists companies and projects for channel seeding", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([{ id: "company-1", name: "Acme" }]))
      .mockResolvedValueOnce(jsonResponse([{ id: "project-1", name: "Project One" }]));
    const client = new PaperclipClient({
      baseUrl: "http://localhost:3100",
      serviceKey: "secret",
      fetchImpl: fetchMock,
      retryDelaysMs: [0],
    });

    const companies = await client.listCompanies();
    const projects = await client.listProjects("company-1");

    expect(companies).toEqual([{ id: "company-1", name: "Acme" }]);
    expect(projects).toEqual([{ id: "project-1", companyId: "company-1", name: "Project One" }]);
  });

  it("delays the 61st non-critical request instead of rejecting it", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ id: "agent-1", name: "Agent" }));
    let now = 0;
    const sleeps: number[] = [];
    const client = new PaperclipClient({
      baseUrl: "http://localhost:3100",
      serviceKey: "secret",
      fetchImpl: fetchMock,
      retryDelaysMs: [0],
      maxRequestsPerMinute: 60,
      nowImpl: () => now,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    for (let index = 0; index < 61; index += 1) {
      await client.getAgent("agent-1");
    }

    expect(fetchMock).toHaveBeenCalledTimes(61);
    expect(sleeps).toEqual([60_000]);
  });

  it("uses the tighter wakeup rate limit for wakeup calls", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ status: "ok" }));
    let now = 0;
    const sleeps: number[] = [];
    const client = new PaperclipClient({
      baseUrl: "http://localhost:3100",
      serviceKey: "secret",
      fetchImpl: fetchMock,
      retryDelaysMs: [0],
      maxWakeupsPerMinute: 1,
      nowImpl: () => now,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    await client.wakeupAgent("agent-1", { source: "automation" });
    await client.wakeupAgent("agent-1", { source: "automation" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([60_000]);
  });
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}
