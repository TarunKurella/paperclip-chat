import type { ChatPresence } from "@paperclip-chat/shared";

export interface PresenceQueue {
  flush(agentId: string): void;
}

export class PresenceStateMachine {
  private readonly states = new Map<string, ChatPresence>();

  constructor(private readonly queue: PresenceQueue) {}

  updateFromPaperclip(agentId: string, status: string): ChatPresence {
    const next =
      status === "running" ? "busy_task" :
      status === "idle" || status === "available" ? "available" :
      status === "error" || status === "terminated" ? "offline" :
      this.states.get(agentId) ?? "offline";

    this.states.set(agentId, next);
    if (next === "available") {
      this.queue.flush(agentId);
    }

    return next;
  }

  getPresence(agentId: string): ChatPresence {
    return this.states.get(agentId) ?? "offline";
  }

  canSpawn(agentId: string): boolean {
    return this.getPresence(agentId) === "available";
  }

  markChatBusy(agentId: string): void {
    this.states.set(agentId, "busy_dm");
  }

  markChatIdle(agentId: string): void {
    this.states.set(agentId, "available");
    this.queue.flush(agentId);
  }
}
