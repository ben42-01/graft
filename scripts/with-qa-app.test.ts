import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { stopChild, cleanup, preflightPort } from "./with-qa-app";

function stubChild(pid = 4242): ChildProcess & EventEmitter {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(child, { pid, exitCode: null, killed: false });
  return child;
}

describe("stopChild (AC1 — the app is stopped however the script exits)", () => {
  let killSpy: ReturnType<typeof mockKill>;

  function mockKill() {
    return vi.spyOn(process, "kill").mockImplementation(() => true);
  }

  beforeEach(() => {
    killSpy = mockKill();
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it("does nothing when there is no child", async () => {
    await stopChild(null);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("does nothing when the child has already exited", async () => {
    const child = stubChild();
    Object.assign(child, { exitCode: 0 });
    await stopChild(child);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("kills the whole process group, not just the direct child — a `next start` that spawns its own next-server is still reaped", async () => {
    const child = stubChild(555);
    const promise = stopChild(child, { graceMs: 1000 });
    // Simulate the OS delivering the signal and the group exiting.
    queueMicrotask(() => child.emit("exit", 0));
    await promise;
    expect(killSpy).toHaveBeenCalledWith(-555, "SIGTERM");
  });

  it("escalates to SIGKILL on the process group if the child does not exit within the grace period", async () => {
    vi.useFakeTimers();
    const child = stubChild(777);
    const promise = stopChild(child, { graceMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    child.emit("exit", 137);
    await promise;
    expect(killSpy).toHaveBeenCalledWith(-777, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(-777, "SIGKILL");
    vi.useRealTimers();
  });

  it("falls back to killing the direct child when the process-group signal fails (e.g. group already gone)", async () => {
    const child = stubChild(999);
    child.kill = vi.fn().mockReturnValue(true);
    killSpy.mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const promise = stopChild(child, { graceMs: 1000 });
    queueMicrotask(() => child.emit("exit", 0));
    await promise;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("resolves even if the child never emits exit, once the hard cap elapses", async () => {
    vi.useFakeTimers();
    const child = stubChild(1010);
    const promise = stopChild(child, { graceMs: 10 });
    await vi.advanceTimersByTimeAsync(1100);
    await promise;
    vi.useRealTimers();
  });
});

describe("cleanup (AC3 — a reaping failure must not mask the test result)", () => {
  it("reports ok when stopChild succeeds", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    const child = stubChild(1);
    const promise = cleanup(child);
    queueMicrotask(() => child.emit("exit", 0));
    const result = await promise;
    expect(result.ok).toBe(true);
    vi.restoreAllMocks();
  });

  it("swallows a cleanup error and reports it distinctly instead of throwing", async () => {
    const child = stubChild(2);
    // Force stopChild's internals to blow up in an unexpected way.
    Object.defineProperty(child, "pid", {
      get() {
        throw new Error("boom");
      },
    });
    const result = await cleanup(child);
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
  });
});

describe("preflightPort (AC2 — an already-held port fails immediately with a usable message)", () => {
  it("throws a clear, actionable error when the port is already in use", async () => {
    const checker = vi.fn().mockResolvedValue(true);
    await expect(preflightPort(3100, checker)).rejects.toThrow(/3100/);
    await expect(preflightPort(3100, checker)).rejects.toThrow(/already in use/i);
    expect(checker).toHaveBeenCalledWith(3100);
  });

  it("resolves without throwing when the port is free", async () => {
    const checker = vi.fn().mockResolvedValue(false);
    await expect(preflightPort(3100, checker)).resolves.toBeUndefined();
  });
});
