import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runIngest } from "../src/ingest/runner.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(tick = vi.fn(async () => {})) {
  const signals = new EventEmitter();
  const close = vi.fn(async () => {});
  const reportError = vi.fn();
  const wait = vi.fn(
    (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new Error("Wait aborted"));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, ms);
        signal.addEventListener("abort", abort, { once: true });
      }),
  );
  const open = vi.fn(() => ({ tick, close }));
  return { signals, tick, close, reportError, wait, open };
}

describe("serial ingest process", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits one second between completed ticks, without overlap or catch-up", async () => {
    const pending = deferred();
    const h = harness(vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined));
    const running = runIngest(h);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.tick).toHaveBeenCalledTimes(1);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(999);
    expect(h.tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.tick).toHaveBeenCalledTimes(2);
    h.signals.emit("SIGTERM");
    expect(await running).toBe(0);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.wait).toHaveBeenCalledWith(1000, expect.any(AbortSignal));
    expect(h.signals.listenerCount("SIGTERM")).toBe(0);
    expect(h.signals.listenerCount("SIGINT")).toBe(0);
  });

  it.each(["SIGINT", "SIGTERM"])("%s cancels a pending wait and closes the pool", async (signal) => {
    const h = harness();
    const running = runIngest(h);
    h.signals.emit(signal);
    expect(await running).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.tick).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it.each(["SIGINT", "SIGTERM"])("%s drains an in-flight tick before cleanup", async (signal) => {
    const pending = deferred();
    const h = harness(vi.fn(() => pending.promise));
    const running = runIngest(h);
    await vi.advanceTimersByTimeAsync(1000);
    h.signals.emit(signal);
    h.signals.emit(signal);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.close).not.toHaveBeenCalled();
    pending.resolve();
    expect(await running).toBe(0);
    expect(h.tick).toHaveBeenCalledTimes(1);
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("waits for a failed tick to roll back, then fails without exposing raw errors", async () => {
    const pending = deferred();
    const h = harness(vi.fn(() => pending.promise));
    const running = runIngest(h);
    await vi.advanceTimersByTimeAsync(1000);
    h.signals.emit("SIGINT");
    expect(h.close).not.toHaveBeenCalled();
    pending.reject(new Error("postgres://credential-sentinel@private/database"));
    expect(await running).toBe(1);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.reportError.mock.calls).toEqual([["Ingest failed."]]);
  });

  it("stops after a tick failure even without a signal", async () => {
    const h = harness(vi.fn().mockRejectedValue(new Error("raw database failure")));
    const running = runIngest(h);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await running).toBe(1);
    expect(h.tick).toHaveBeenCalledTimes(1);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.reportError.mock.calls).toEqual([["Ingest failed."]]);
  });

  it("sanitizes configuration/resource creation failures and removes signal handlers", async () => {
    const h = harness();
    h.open.mockImplementation(() => {
      throw new Error("credential-sentinel");
    });
    expect(await runIngest(h)).toBe(1);
    expect(h.close).not.toHaveBeenCalled();
    expect(h.reportError.mock.calls).toEqual([["Ingest failed."]]);
    expect(h.signals.listenerCount("SIGTERM")).toBe(0);
    expect(h.signals.listenerCount("SIGINT")).toBe(0);
  });

  it("reports pool cleanup failure with a fixed diagnostic and nonzero exit", async () => {
    const h = harness();
    h.close.mockRejectedValue(new Error("credential-sentinel"));
    const running = runIngest(h);
    h.signals.emit("SIGTERM");
    expect(await running).toBe(1);
    expect(h.reportError.mock.calls).toEqual([["Ingest database shutdown failed."]]);
  });
});
