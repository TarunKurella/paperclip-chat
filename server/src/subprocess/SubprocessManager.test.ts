import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Channel, Turn } from "@paperclip-chat/shared";
import { describe, expect, it, vi } from "vitest";
import { PresenceStateMachine } from "./PresenceStateMachine.js";
import { SubprocessManager } from "./SubprocessManager.js";

describe("SubprocessManager", () => {
  it("queues work when the agent is busy with a Paperclip task", async () => {
    const queue = { flush: vi.fn() };
    const presence = new PresenceStateMachine(queue);
    presence.updateFromPaperclip("agent-1", "running");

    const runner = vi.fn();
    const manager = new SubprocessManager(
      presence,
      vi.fn().mockResolvedValue({ cwd: "/tmp/workspace", sessionPath: "/tmp/session" }),
      runner,
      { saveAgentState: vi.fn(), listTurns: vi.fn().mockResolvedValue([]) },
      { broadcast: vi.fn() },
      { CHAT_TOKEN_SECRET: "secret", CHAT_API_URL: "http://127.0.0.1:4011" },
    );

    const result = await manager.run(
      makeRequest({
        channel: makeChannel({ type: "company_general", name: "General" }),
      }),
    );

    expect(result.status).toBe("queued");
    expect(runner).not.toHaveBeenCalled();
  });

  it("allows direct dm spawns even when websocket presence is offline", async () => {
    const queue = { flush: vi.fn() };
    const presence = new PresenceStateMachine(queue);
    const runner = vi.fn().mockResolvedValue({});
    const manager = new SubprocessManager(
      presence,
      vi.fn().mockResolvedValue({ cwd: "/tmp/workspace", sessionPath: "/tmp/session" }),
      runner,
      { saveAgentState: vi.fn().mockResolvedValue(undefined), listTurns: vi.fn().mockResolvedValue([]) },
      { broadcast: vi.fn() },
      { CHAT_TOKEN_SECRET: "secret", CHAT_API_URL: "http://127.0.0.1:4011" },
    );

    const result = await manager.run(makeRequest());

    expect(result.status).toBe("completed");
    expect(runner).toHaveBeenCalled();
  });

  it("allows spawns when Paperclip reports the agent as idle even without ws presence", async () => {
    const queue = { flush: vi.fn() };
    const presence = new PresenceStateMachine(queue);
    const runner = vi.fn().mockResolvedValue({});
    const manager = new SubprocessManager(
      presence,
      vi.fn().mockResolvedValue({ cwd: "/tmp/workspace", sessionPath: "/tmp/session" }),
      runner,
      { saveAgentState: vi.fn().mockResolvedValue(undefined), listTurns: vi.fn().mockResolvedValue([]) },
      { broadcast: vi.fn() },
      { CHAT_TOKEN_SECRET: "secret", CHAT_API_URL: "http://127.0.0.1:4011" },
    );

    const result = await manager.run(
      makeRequest({
        channel: makeChannel({ type: "company_general", name: "General" }),
        agentStatus: "idle",
      }),
    );

    expect(result.status).toBe("completed");
    expect(runner).toHaveBeenCalled();
  });

  it("injects chat env vars and resume args for subprocess runs", async () => {
    const queue = { flush: vi.fn() };
    const presence = new PresenceStateMachine(queue);
    presence.updateFromPaperclip("agent-1", "idle");

    const runner = vi.fn().mockResolvedValue({
      cliSessionId: "cli-1",
      cliSessionPath: "/tmp/session",
      actualInputTokens: 12,
      outputTokens: 34,
      stream: [{ type: "delta", delta: "hello" }],
    });
    const stateStore = { saveAgentState: vi.fn().mockResolvedValue(undefined) };
    const hub = { broadcast: vi.fn() };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const manager = new SubprocessManager(
      presence,
      vi.fn().mockResolvedValue({ cwd: "/tmp/workspace", sessionPath: "/tmp/session" }),
      runner,
      { ...stateStore, listTurns: vi.fn().mockResolvedValue([]) },
      hub,
      { CHAT_TOKEN_SECRET: "secret", CHAT_API_URL: "http://127.0.0.1:4011" },
    );

    await manager.run(makeRequest({ adapterType: "claude_local", cliSessionId: "resume-1" }));

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/workspace",
        adapterType: "claude_local",
        args: ["--print", "-", "--output-format", "stream-json", "--verbose", "--resume", "resume-1"],
        stdin: "Prompt body",
        env: expect.objectContaining({
          CHAT_API_URL: "http://127.0.0.1:4011",
          CHAT_SESSION_ID: "session-1",
          PAPERCLIP_AGENT_NAME: "",
          PAPERCLIP_WAKE_REASON: "chat_message",
          PAPERCLIP_WAKE_COMMENT_ID: "turn-1",
        }),
      }),
    );
    expect(stateStore.saveAgentState).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "active",
        cliSessionId: "cli-1",
        anchorSeq: 9,
        tokensThisSession: 46,
      }),
    );
    expect(hub.broadcast).toHaveBeenCalledWith("channel-1", {
      type: "agent.typing",
      payload: { participantId: "agent-1", active: true },
    });
    expect(hub.broadcast).toHaveBeenCalledWith("channel-1", {
      type: "chat.message.stream",
      payload: { delta: "hello", done: false, participantId: "agent-1" },
    });
    expect(hub.broadcast).toHaveBeenCalledWith("channel-1", {
      type: "agent.typing",
      payload: { participantId: "agent-1", active: false },
    });
    vi.unstubAllGlobals();
  });

  it("falls back to a cold run when a stored resume id is stale", async () => {
    const queue = { flush: vi.fn() };
    const presence = new PresenceStateMachine(queue);
    presence.updateFromPaperclip("agent-1", "idle");

    const runner = vi
      .fn()
      .mockRejectedValueOnce(new Error("resume session not found"))
      .mockResolvedValueOnce({
        cliSessionId: "fresh-1",
        actualInputTokens: 4,
        outputTokens: 6,
      });
    const stateStore = { saveAgentState: vi.fn().mockResolvedValue(undefined) };
    const manager = new SubprocessManager(
      presence,
      vi.fn().mockResolvedValue({ cwd: "/tmp/workspace", sessionPath: "/tmp/session" }),
      runner,
      { ...stateStore, listTurns: vi.fn().mockResolvedValue([]) },
      { broadcast: vi.fn() },
      { CHAT_TOKEN_SECRET: "secret", CHAT_API_URL: "http://127.0.0.1:4011" },
    );

    await manager.run(makeRequest({ adapterType: "claude_local", cliSessionId: "stale-1" }));

    expect(runner).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        args: ["--print", "-", "--output-format", "stream-json", "--verbose", "--resume", "stale-1"],
      }),
    );
    expect(runner).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        args: ["--print", "-", "--output-format", "stream-json", "--verbose"],
      }),
    );
    expect(stateStore.saveAgentState).toHaveBeenCalledWith(
      expect.objectContaining({
        cliSessionId: "fresh-1",
        tokensThisSession: 10,
      }),
    );
  });

  it("clears a stale resume id if the cold retry succeeds without returning a new session id", async () => {
    const queue = { flush: vi.fn() };
    const presence = new PresenceStateMachine(queue);
    presence.updateFromPaperclip("agent-1", "idle");

    const stateStore = { saveAgentState: vi.fn().mockResolvedValue(undefined) };
    const manager = new SubprocessManager(
      presence,
      vi.fn().mockResolvedValue({ cwd: "/tmp/workspace", sessionPath: "/tmp/session" }),
      vi
        .fn()
        .mockRejectedValueOnce(new Error("invalid resume session"))
        .mockResolvedValueOnce({ actualInputTokens: 2, outputTokens: 3 }),
      { ...stateStore, listTurns: vi.fn().mockResolvedValue([]) },
      { broadcast: vi.fn() },
      { CHAT_TOKEN_SECRET: "secret", CHAT_API_URL: "http://127.0.0.1:4011" },
    );

    await manager.run(makeRequest({ adapterType: "codex_local", cliSessionId: "stale-codex" }));

    expect(stateStore.saveAgentState).toHaveBeenCalledWith(
      expect.objectContaining({
        cliSessionId: null,
        tokensThisSession: 5,
      }),
    );
  });

  it("defaults CHAT_API_URL to the local chat server instead of Paperclip API url", async () => {
    const queue = { flush: vi.fn() };
    const presence = new PresenceStateMachine(queue);
    const runner = vi.fn().mockResolvedValue({});
    const manager = new SubprocessManager(
      presence,
      vi.fn().mockResolvedValue({ cwd: "/tmp/workspace", sessionPath: "/tmp/session" }),
      runner,
      { saveAgentState: vi.fn().mockResolvedValue(undefined), listTurns: vi.fn().mockResolvedValue([]) },
      { broadcast: vi.fn() },
      {
        CHAT_TOKEN_SECRET: "secret",
        PAPERCLIP_API_URL: "http://127.0.0.1:3100",
        PORT: "4000",
      },
    );

    await manager.run(makeRequest({ adapterType: "codex_local" }));

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          CHAT_API_URL: "http://127.0.0.1:4000",
          PAPERCLIP_API_URL: "http://127.0.0.1:3100",
        }),
      }),
    );
  });

  it("prepares a managed codex home seeded from the shared codex home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-chat-codex-home-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");

    const queue = { flush: vi.fn() };
    const presence = new PresenceStateMachine(queue);
    const runner = vi.fn().mockResolvedValue({});
    const manager = new SubprocessManager(
      presence,
      vi.fn().mockResolvedValue({ cwd: "/tmp/workspace", sessionPath: "/tmp/session" }),
      runner,
      { saveAgentState: vi.fn().mockResolvedValue(undefined), listTurns: vi.fn().mockResolvedValue([]) },
      { broadcast: vi.fn() },
      {
        CHAT_TOKEN_SECRET: "secret",
        CHAT_API_URL: "http://127.0.0.1:4011",
        CODEX_HOME: sharedCodexHome,
        PAPERCLIP_HOME: paperclipHome,
      },
    );

    try {
      await manager.run(makeRequest({ adapterType: "codex_local" }));

      const runnerEnv = runner.mock.calls[0]?.[0]?.env as Record<string, string>;
      const managedCodexHome = path.join(
        paperclipHome,
        "instances",
        "default",
        "companies",
        "company-1",
        "codex-home",
      );
      expect(runnerEnv.CODEX_HOME).toBe(managedCodexHome);
      expect((await fs.lstat(path.join(managedCodexHome, "auth.json"))).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(path.join(managedCodexHome, "auth.json"))).toBe(
        await fs.realpath(path.join(sharedCodexHome, "auth.json")),
      );
      expect(await fs.readFile(path.join(managedCodexHome, "config.toml"), "utf8")).toBe(
        'model = "codex-mini-latest"\n',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent spawns per agent", async () => {
    const queue = { flush: vi.fn() };
    const presence = new PresenceStateMachine(queue);
    presence.updateFromPaperclip("agent-1", "idle");

    const order: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const runner = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            order.push("start-1");
            releaseFirst = () => {
              order.push("end-1");
              resolve({});
            };
          }),
      )
      .mockImplementationOnce(async () => {
        order.push("start-2");
        order.push("end-2");
        return {};
      });

    const manager = new SubprocessManager(
      presence,
      vi.fn().mockResolvedValue({ cwd: "/tmp/workspace", sessionPath: "/tmp/session" }),
      runner,
      { saveAgentState: vi.fn().mockResolvedValue(undefined), listTurns: vi.fn().mockResolvedValue([]) },
      { broadcast: vi.fn() },
      { CHAT_TOKEN_SECRET: "secret", CHAT_API_URL: "http://127.0.0.1:4011" },
    );

    const first = manager.run(makeRequest());
    const second = manager.run(makeRequest());
    await waitFor(() => releaseFirst !== null);
    const release = releaseFirst as (() => void) | null;
    release?.();
    await Promise.all([first, second]);

    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  it("emits agent.error and releases the chat-busy state on failure", async () => {
    const queue = { flush: vi.fn() };
    const presence = new PresenceStateMachine(queue);
    presence.updateFromPaperclip("agent-1", "idle");

    const hub = { broadcast: vi.fn() };
    const manager = new SubprocessManager(
      presence,
      vi.fn().mockResolvedValue({ cwd: "/tmp/workspace", sessionPath: "/tmp/session" }),
      vi.fn().mockRejectedValue(new Error("spawn failed")),
      { saveAgentState: vi.fn(), listTurns: vi.fn().mockResolvedValue([]) },
      hub,
      { CHAT_TOKEN_SECRET: "secret", CHAT_API_URL: "http://127.0.0.1:4011" },
    );

    await expect(manager.run(makeRequest())).rejects.toThrow("spawn failed");

    expect(hub.broadcast).toHaveBeenCalledWith("channel-1", {
      type: "agent.error",
      payload: { agentId: "agent-1", message: "spawn failed" },
    });
    expect(presence.getPresence("agent-1")).toBe("available");
  });

  it("posts a fallback agent turn when the local cli returns text without sending back to chat", async () => {
    const queue = { flush: vi.fn() };
    const presence = new PresenceStateMachine(queue);
    presence.updateFromPaperclip("agent-1", "idle");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const manager = new SubprocessManager(
      presence,
      vi.fn().mockResolvedValue({ cwd: "/tmp/workspace", sessionPath: "/tmp/session" }),
      vi.fn().mockResolvedValue({
        stream: [{ type: "delta", delta: "fallback hello" }],
        actualInputTokens: 1,
        outputTokens: 2,
      }),
      {
        saveAgentState: vi.fn().mockResolvedValue(undefined),
        listTurns: vi.fn().mockResolvedValue([]),
      },
      { broadcast: vi.fn() },
      { CHAT_TOKEN_SECRET: "secret", CHAT_API_URL: "http://127.0.0.1:4011" },
    );

    await manager.run(makeRequest());

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4011/api/sessions/session-1/send",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: expect.stringContaining("Bearer "),
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ text: "fallback hello", mentionedIds: [] }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("passes the Paperclip agent name into the local subprocess env", async () => {
    const queue = { flush: vi.fn() };
    const presence = new PresenceStateMachine(queue);
    presence.updateFromPaperclip("agent-1", "idle");

    const runner = vi.fn().mockResolvedValue({});
    const manager = new SubprocessManager(
      presence,
      vi.fn().mockResolvedValue({ cwd: "/tmp/workspace", sessionPath: "/tmp/session" }),
      runner,
      { saveAgentState: vi.fn().mockResolvedValue(undefined), listTurns: vi.fn().mockResolvedValue([]) },
      { broadcast: vi.fn() },
      { CHAT_TOKEN_SECRET: "secret", CHAT_API_URL: "http://127.0.0.1:4011" },
    );

    await manager.run(makeRequest({ agentName: "tester" }));

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          PAPERCLIP_AGENT_ID: "agent-1",
          PAPERCLIP_AGENT_NAME: "tester",
        }),
      }),
    );
  });
});

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Condition not reached in time");
}

function makeRequest(overrides: Partial<Parameters<SubprocessManager["run"]>[0]> = {}) {
  return {
    adapterType: "claude_local",
    agentStatus: null,
    agentId: "agent-1",
    sessionId: "session-1",
    channel: makeChannel(),
    channelId: "channel-1",
    prompt: "Prompt body",
    currentSeq: 9,
    triggeringTurn: makeTurn(),
    agentState: makeAgentState(),
    ...overrides,
  };
}

function makeAgentState() {
  return {
    id: "state-1",
    sessionId: "session-1",
    participantId: "agent-1",
    status: "observing" as const,
    anchorSeq: 3,
    scaffoldIssueId: null,
    cliSessionId: null,
    cliSessionPath: null,
    idleTurnCount: 2,
    tokensThisSession: 0,
  };
}

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "channel-1",
    type: "dm",
    companyId: "company-1",
    paperclipRefId: null,
    name: "Direct chat",
    ...overrides,
  };
}

function makeTurn(): Turn {
  return {
    id: "turn-1",
    sessionId: "session-1",
    seq: 9,
    fromParticipantId: "human-1",
    content: "hello",
    tokenCount: 8,
    summarize: true,
    mentionedIds: null,
    isDecision: false,
    createdAt: "2026-03-21T00:00:00.000Z",
  };
}
