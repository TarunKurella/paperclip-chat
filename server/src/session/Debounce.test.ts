import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DebounceBuffer } from "./Debounce.js";

describe("DebounceBuffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes one batched call after rapid messages", async () => {
    const flush = vi.fn();
    const buffer = new DebounceBuffer(flush, 800);

    buffer.enqueue("agent-1", "session-1", makeTurn("turn-1", "session-1"));
    vi.advanceTimersByTime(200);
    buffer.enqueue("agent-1", "session-1", makeTurn("turn-2", "session-1"));
    vi.advanceTimersByTime(200);
    buffer.enqueue("agent-1", "session-1", makeTurn("turn-3", "session-1"));

    vi.advanceTimersByTime(799);
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await vi.runAllTimersAsync();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith("agent-1", "session-1", [
      makeTurn("turn-1", "session-1"),
      makeTurn("turn-2", "session-1"),
      makeTurn("turn-3", "session-1"),
    ]);
  });

  it("resets the timer on each new enqueue", async () => {
    const flush = vi.fn();
    const buffer = new DebounceBuffer(flush, 800);

    buffer.enqueue("agent-1", "session-1", makeTurn("turn-1", "session-1"));
    vi.advanceTimersByTime(500);
    buffer.enqueue("agent-1", "session-1", makeTurn("turn-2", "session-1"));

    vi.advanceTimersByTime(299);
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    await vi.runAllTimersAsync();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0]?.[2]).toHaveLength(2);
  });

  it("flushes independently by agent", async () => {
    const flush = vi.fn();
    const buffer = new DebounceBuffer(flush, 800);

    buffer.enqueue("agent-1", "session-1", makeTurn("turn-1", "session-1"));
    buffer.enqueue("agent-2", "session-1", makeTurn("turn-2", "session-1"));

    vi.advanceTimersByTime(800);
    await vi.runAllTimersAsync();

    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenNthCalledWith(1, "agent-1", "session-1", [makeTurn("turn-1", "session-1")]);
    expect(flush).toHaveBeenNthCalledWith(2, "agent-2", "session-1", [makeTurn("turn-2", "session-1")]);
  });

  it("can be flushed explicitly before the timer fires", async () => {
    const flush = vi.fn();
    const buffer = new DebounceBuffer(flush, 800);

    buffer.enqueue("agent-1", "session-1", makeTurn("turn-1", "session-1"));
    await buffer.flush("agent-1", "session-1");

    expect(flush).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(800);
    await vi.runAllTimersAsync();
    expect(flush).toHaveBeenCalledTimes(1);
  });
});

function makeTurn(id: string, sessionId: string) {
  return { id, sessionId };
}
