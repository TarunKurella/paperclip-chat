export interface IdleSessionCloser {
  closeSession(input: { sessionId: string; crystallize?: boolean }): Promise<unknown>;
}

export class IdleSessionCoordinator {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly closer: IdleSessionCloser,
    private readonly idleMs: number = 10 * 60 * 1000,
  ) {}

  track(sessionId: string): void {
    this.touch(sessionId);
  }

  touch(sessionId: string): void {
    this.untrack(sessionId);
    const timer = setTimeout(() => {
      void this.closer.closeSession({ sessionId, crystallize: false }).finally(() => {
        this.timers.delete(sessionId);
      });
    }, this.idleMs);
    this.timers.set(sessionId, timer);
  }

  untrack(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  close(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
