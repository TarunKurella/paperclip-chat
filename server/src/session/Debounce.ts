import { CHAT_DEFAULTS } from "@paperclip-chat/shared";

export interface DebouncedTurn {
  id: string;
  sessionId: string;
}

export type FlushHandler<TTurn> = (agentId: string, sessionId: string, turns: TTurn[]) => void | Promise<void>;

interface BufferEntry<TTurn> {
  agentId: string;
  sessionId: string;
  turns: TTurn[];
  timer: ReturnType<typeof setTimeout>;
}

export class DebounceBuffer<TTurn extends DebouncedTurn> {
  private readonly buffers = new Map<string, BufferEntry<TTurn>>();

  constructor(
    private readonly flushHandler: FlushHandler<TTurn>,
    private readonly delayMs = CHAT_DEFAULTS.COALESCE_MS,
  ) {}

  enqueue(agentId: string, sessionId: string, turn: TTurn): void {
    const key = getBufferKey(agentId, sessionId);
    const existing = this.buffers.get(key);

    if (existing) {
      clearTimeout(existing.timer);
      existing.turns.push(turn);
      existing.timer = this.createTimer(key);
      return;
    }

    this.buffers.set(key, {
      agentId,
      sessionId,
      turns: [turn],
      timer: this.createTimer(key),
    });
  }

  async flush(agentId: string, sessionId: string): Promise<void> {
    await this.flushKey(getBufferKey(agentId, sessionId));
  }

  close(): void {
    for (const entry of this.buffers.values()) {
      clearTimeout(entry.timer);
    }
    this.buffers.clear();
  }

  private createTimer(key: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      void this.flushKey(key);
    }, this.delayMs);
  }

  private async flushKey(key: string): Promise<void> {
    const entry = this.buffers.get(key);
    if (!entry) {
      return;
    }

    this.buffers.delete(key);
    clearTimeout(entry.timer);
    await this.flushHandler(entry.agentId, entry.sessionId, [...entry.turns]);
  }
}

function getBufferKey(agentId: string, sessionId: string): string {
  return `${agentId}:${sessionId}`;
}
