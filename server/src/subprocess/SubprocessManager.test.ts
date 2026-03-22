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
      { saveAgentState: vi.fn() },
      { broadcast: vi.fn() },
      { CHAT_TOKEN_SECRET: "secret", CHAT_API_URL: "http://127.0.0.1:4011" },
    );

    const result = await manager.run(makeRequest());

    expect(result.status).toBe("queued");
    expect(runner).not.toHaveBeenCalled();
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
    const manager = new SubprocessManager(
      presence,
      vi.fn().mockResolvedValue({ cwd: "/tmp/workspace", sessionPath: "/tmp/session" }),
      runner,
      stateStore,
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
      { saveAgentState: vi.fn().mockResolvedValue(undefined) },
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
      { saveAgentState: vi.fn() },
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

function makeChannel(): Channel {
  return {
    id: "channel-1",
    type: "dm",
    companyId: "company-1",
    paperclipRefId: null,
    name: "Direct chat",
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
