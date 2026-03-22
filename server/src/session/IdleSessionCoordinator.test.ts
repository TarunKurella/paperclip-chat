import { describe, expect, it, vi } from "vitest";
import { IdleSessionCoordinator } from "./IdleSessionCoordinator.js";

describe("IdleSessionCoordinator", () => {
  it("auto-closes tracked sessions after the idle timeout", async () => {
    vi.useFakeTimers();
    const closer = {
      closeSession: vi.fn().mockResolvedValue(undefined),
    };

    const coordinator = new IdleSessionCoordinator(closer, 1_000);
    coordinator.track("session-1");

    await vi.advanceTimersByTimeAsync(1_001);

    expect(closer.closeSession).toHaveBeenCalledWith({ sessionId: "session-1", crystallize: false });
    coordinator.close();
    vi.useRealTimers();
  });

  it("resets the timeout when touched", async () => {
    vi.useFakeTimers();
    const closer = {
      closeSession: vi.fn().mockResolvedValue(undefined),
    };

    const coordinator = new IdleSessionCoordinator(closer, 1_000);
    coordinator.track("session-1");
    await vi.advanceTimersByTimeAsync(900);
    coordinator.touch("session-1");
    await vi.advanceTimersByTimeAsync(900);

    expect(closer.closeSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(101);
    expect(closer.closeSession).toHaveBeenCalledWith({ sessionId: "session-1", crystallize: false });
    coordinator.close();
    vi.useRealTimers();
  });

  it("clears timers when the session is untracked", async () => {
    vi.useFakeTimers();
    const closer = {
      closeSession: vi.fn().mockResolvedValue(undefined),
    };

    const coordinator = new IdleSessionCoordinator(closer, 1_000);
    coordinator.track("session-1");
    coordinator.untrack("session-1");
    await vi.advanceTimersByTimeAsync(1_500);

    expect(closer.closeSession).not.toHaveBeenCalled();
    coordinator.close();
    vi.useRealTimers();
  });
});
