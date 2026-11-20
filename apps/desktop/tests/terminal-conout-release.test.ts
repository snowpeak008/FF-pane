/**
 * T11.19：node-pty 每个终端一个输出工作线程，结束后要自己收。
 * 用假的 _agent 结构测收的时机、只收一次、认不出结构不抛错。
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONOUT_RELEASE_AFTER_EXIT_MS,
  CONOUT_RELEASE_KILL_WAIT_MS,
  conoutWorkerStats,
  createConoutWorkerReleaser,
  releaseAllConoutWorkers,
} from "../src/main/terminal/factory";

class FakeWorker extends EventEmitter {
  readonly terminate = vi.fn(() => {
    this.emit("exit", 1);
    return Promise.resolve(1);
  });
}

function fakePty(worker: unknown = new FakeWorker()): {
  readonly pty: unknown;
  readonly worker: FakeWorker;
} {
  return {
    pty: { _agent: { _conoutSocketWorker: { _worker: worker } } },
    worker: worker as FakeWorker,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  releaseAllConoutWorkers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createConoutWorkerReleaser", () => {
  it("退出事件送到之前不收，送到后再等 2 秒才收", () => {
    const { pty, worker } = fakePty();
    const releaser = createConoutWorkerReleaser(pty);
    vi.advanceTimersByTime(60_000);
    expect(worker.terminate).not.toHaveBeenCalled();
    releaser.exitDelivered();
    vi.advanceTimersByTime(CONOUT_RELEASE_AFTER_EXIT_MS - 1);
    expect(worker.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("只收一次", () => {
    const { pty, worker } = fakePty();
    const releaser = createConoutWorkerReleaser(pty);
    releaser.exitDelivered();
    releaser.exitDelivered();
    vi.advanceTimersByTime(CONOUT_RELEASE_AFTER_EXIT_MS);
    releaser.releaseNow();
    releaser.killed();
    vi.advanceTimersByTime(CONOUT_RELEASE_KILL_WAIT_MS);
    releaseAllConoutWorkers();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("kill 后退出事件来了：照样等送到后 2 秒", () => {
    const { pty, worker } = fakePty();
    const releaser = createConoutWorkerReleaser(pty);
    releaser.killed();
    vi.advanceTimersByTime(1_000);
    releaser.exitDelivered();
    vi.advanceTimersByTime(CONOUT_RELEASE_AFTER_EXIT_MS - 1);
    expect(worker.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("kill 后退出事件 5 秒没来也收", () => {
    const { pty, worker } = fakePty();
    const releaser = createConoutWorkerReleaser(pty);
    releaser.killed();
    vi.advanceTimersByTime(CONOUT_RELEASE_KILL_WAIT_MS - 1);
    expect(worker.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("退出软件时不等那 2 秒，剩下的一起收", () => {
    const exited = fakePty();
    const running = fakePty();
    createConoutWorkerReleaser(exited.pty).exitDelivered();
    createConoutWorkerReleaser(running.pty);
    releaseAllConoutWorkers();
    expect(exited.worker.terminate).toHaveBeenCalledTimes(1);
    expect(running.worker.terminate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CONOUT_RELEASE_AFTER_EXIT_MS);
    expect(exited.worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("认不出内部结构：不抛错，什么都不做", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const pty of [undefined, {}, { _agent: {} }, fakePty({ terminate: "no" }).pty]) {
      const releaser = createConoutWorkerReleaser(pty);
      expect(() => {
        releaser.exitDelivered();
        releaser.killed();
        vi.advanceTimersByTime(CONOUT_RELEASE_KILL_WAIT_MS);
        releaser.releaseNow();
      }).not.toThrow();
    }
    expect(error.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("terminate 抛错或返回失败的 Promise 都不往外抛", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const throwing = createConoutWorkerReleaser(
      fakePty({
        terminate: () => {
          throw new Error("boom");
        },
      }).pty,
    );
    const rejecting = createConoutWorkerReleaser(
      fakePty({ terminate: () => Promise.reject(new Error("boom")) }).pty,
    );
    expect(() => throwing.releaseNow()).not.toThrow();
    expect(() => rejecting.releaseNow()).not.toThrow();
    await vi.runAllTimersAsync();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("按工作线程真的结束来记已收数", () => {
    const before = conoutWorkerStats();
    const a = fakePty();
    const b = fakePty();
    createConoutWorkerReleaser(a.pty).exitDelivered();
    createConoutWorkerReleaser(b.pty);
    vi.advanceTimersByTime(CONOUT_RELEASE_AFTER_EXIT_MS);
    // node-pty 自己收掉的（系统 conpty 的 kill）也算
    b.worker.emit("exit", 1);
    const after = conoutWorkerStats();
    expect(after.opened - before.opened).toBe(2);
    expect(after.released - before.released).toBe(2);
  });
});
