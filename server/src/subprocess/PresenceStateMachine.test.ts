import { describe, expect, it, vi } from "vitest";
import { PresenceStateMachine } from "./PresenceStateMachine.js";

describe("PresenceStateMachine", () => {
  it("maps running Paperclip state to busy_task and blocks spawns", () => {
    const queue = { flush: vi.fn() };
    const state = new PresenceStateMachine(queue);

    expect(state.updateFromPaperclip("agent-1", "running")).toBe("busy_task");
    expect(state.canSpawn("agent-1")).toBe(false);
  });

  it("flushes queued work when an agent becomes available", () => {
    const queue = { flush: vi.fn() };
    const state = new PresenceStateMachine(queue);

    state.updateFromPaperclip("agent-1", "running");
    state.updateFromPaperclip("agent-1", "idle");

    expect(queue.flush).toHaveBeenCalledWith("agent-1");
    expect(state.canSpawn("agent-1")).toBe(true);
  });

  it("marks agent offline for terminated or error states", () => {
    const queue = { flush: vi.fn() };
    const state = new PresenceStateMachine(queue);

    expect(state.updateFromPaperclip("agent-1", "terminated")).toBe("offline");
    expect(state.canSpawn("agent-1")).toBe(false);
  });

  it("uses busy_dm while the chat subprocess is active", () => {
    const queue = { flush: vi.fn() };
    const state = new PresenceStateMachine(queue);

    state.updateFromPaperclip("agent-1", "idle");
    state.markChatBusy("agent-1");

    expect(state.getPresence("agent-1")).toBe("busy_dm");
  });
});
