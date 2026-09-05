/**
 * T8.2b 退出协调器单测：before-quit 的时序规则（无在飞放行 / 有在飞先收尾再退 /
 * 超时放行 / 重入不重复 / 自己触发的 quit 放行）。全部依赖注入，用假时钟驱动超时。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createQuitCoordinator,
  QUIT_TOTAL_BUDGET_MS,
  type QuitCoordinatorDeps,
} from "../src/main/session/quit";

interface Harness {
  readonly deps: QuitCoordinatorDeps;
  readonly quits: number[];
  readonly prepares: number;
  readonly logs: string[];
  /** 手动放行 prepare 的 deferred。 */
  release(): void;
}

function makeHarness(opts: {
  readonly inflight: boolean;
  readonly prepareThrows?: boolean;
}): Harness {
  const quits: number[] = [];
  const logs: string[] = [];
  let release: () => void = () => undefined;
  const state = { prepares: 0 };
  const deps: QuitCoordinatorDeps = {
    hasInflight: () => opts.inflight,
    prepare: () => {
      state.prepares += 1;
      if (opts.prepareThrows === true) {
        return Promise.reject(new Error("settle failed"));
      }
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    quit: () => {
      quits.push(Date.now());
    },
    log: (message) => {
      logs.push(message);
    },
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  };
  return {
    deps,
    quits,
    get prepares() {
      return state.prepares;
    },
    logs,
    release: () => release(),
  };
}

function event(): { preventDefault: () => void; prevented: number } {
  const e = {
    prevented: 0,
    preventDefault() {
      e.prevented += 1;
    },
  };
  return e;
}

/** 让微任务队列跑空（prepare 解决后 race → closeRuntimes → finishAndQuit 都是微任务）。 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createQuitCoordinator", () => {
  it("无在飞轮 → 不 preventDefault、不调 prepare，直接放行", async () => {
    const h = makeHarness({ inflight: false });
    const coordinator = createQuitCoordinator(h.deps);
    const e = event();

    coordinator.onBeforeQuit(e);
    await flushMicrotasks();

    expect(e.prevented).toBe(0);
    expect(h.prepares).toBe(0);
    // 我们没有自己调 quit——Electron 照常退出
    expect(h.quits).toHaveLength(0);
    expect(coordinator.phase()).toBe("quitting");
  });

  it("有在飞轮 → 首次 preventDefault 并收尾，收尾完成后调 quit 恰好一次", async () => {
    const h = makeHarness({ inflight: true });
    const coordinator = createQuitCoordinator(h.deps);
    const e = event();

    coordinator.onBeforeQuit(e);
    expect(e.prevented).toBe(1);
    expect(h.prepares).toBe(1);
    expect(coordinator.phase()).toBe("preparing");
    expect(h.quits).toHaveLength(0);

    h.release();
    await flushMicrotasks();

    expect(h.quits).toHaveLength(1);
    expect(coordinator.phase()).toBe("quitting");
    // 我们自己那次 quit 引发的 before-quit 放行（否则永远退不出）
    const again = event();
    coordinator.onBeforeQuit(again);
    expect(again.prevented).toBe(0);
    expect(h.prepares).toBe(1);
  });

  it("收尾超过总时限 → 照样 quit（子进程由 Job Object 兜底，没写完的由启动修正兜底）", async () => {
    const h = makeHarness({ inflight: true });
    const coordinator = createQuitCoordinator(h.deps);

    coordinator.onBeforeQuit(event());
    await vi.advanceTimersByTimeAsync(QUIT_TOTAL_BUDGET_MS - 1);
    expect(h.quits).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(h.quits).toHaveLength(1);
    expect(h.logs.some((line) => line.includes("budget"))).toBe(true);

    // 迟到的 prepare 完成不会再触发第二次 quit
    h.release();
    await flushMicrotasks();
    expect(h.quits).toHaveLength(1);
  });

  it("收尾期间重入 → 只 preventDefault，不重复 prepare、不重复 quit", async () => {
    const h = makeHarness({ inflight: true });
    const coordinator = createQuitCoordinator(h.deps);

    coordinator.onBeforeQuit(event());
    const second = event();
    const third = event();
    coordinator.onBeforeQuit(second);
    coordinator.onBeforeQuit(third);

    expect(second.prevented).toBe(1);
    expect(third.prevented).toBe(1);
    expect(h.prepares).toBe(1);

    h.release();
    await flushMicrotasks();
    expect(h.quits).toHaveLength(1);
  });

  it("prepare 抛错视同完成：仍然退出，不卡死", async () => {
    const h = makeHarness({ inflight: true, prepareThrows: true });
    const coordinator = createQuitCoordinator(h.deps);

    coordinator.onBeforeQuit(event());
    await flushMicrotasks();

    expect(h.quits).toHaveLength(1);
    expect(h.logs.some((line) => line.includes("prepareForQuit failed"))).toBe(true);
  });

  it("可注入更短的时限（接线处不改常量也能收紧）", async () => {
    const h = makeHarness({ inflight: true });
    const coordinator = createQuitCoordinator({ ...h.deps, budgetMs: 100 });

    coordinator.onBeforeQuit(event());
    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();

    expect(h.quits).toHaveLength(1);
  });
});

describe("常驻 Runtime 资源关停（T8.5c，opencode server）", () => {
  it("无在飞轮但 server 活着 → 拦截一次，只关 server 不跑 prepare，再 quit", async () => {
    const h = makeHarness({ inflight: false });
    const order: string[] = [];
    let releaseClose: () => void = () => undefined;
    const coordinator = createQuitCoordinator({
      ...h.deps,
      hasRuntimeResources: () => true,
      closeRuntimes: () => {
        order.push("close");
        return new Promise<void>((resolve) => {
          releaseClose = resolve;
        });
      },
    });
    const e = event();
    coordinator.onBeforeQuit(e);
    expect(e.prevented).toBe(1);
    // closeRuntimes 在收尾链的微任务里被调到：先等它挂上再放行
    await flushMicrotasks();
    expect(h.prepares).toBe(0); // 无在飞轮：不跑 prepareForQuit
    expect(order).toEqual(["close"]);
    expect(h.quits).toHaveLength(0); // server 未关完不退

    releaseClose();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(h.quits).toHaveLength(1);
  });

  it("有在飞轮且 server 活着 → 先 prepare 后 close（取消波要经 server 的 /abort）", async () => {
    const order: string[] = [];
    const h = makeHarness({ inflight: true });
    const coordinator = createQuitCoordinator({
      ...h.deps,
      prepare: () => {
        order.push("prepare");
        return Promise.resolve();
      },
      hasRuntimeResources: () => true,
      closeRuntimes: () => {
        order.push("close");
        return Promise.resolve();
      },
    });
    coordinator.onBeforeQuit(event());
    await flushMicrotasks();
    expect(order).toEqual(["prepare", "close"]);
    expect(h.quits).toHaveLength(1);
  });

  it("server 关停超出小预算 → 照样 quit（Job Object 兜底），日志留痕", async () => {
    const h = makeHarness({ inflight: false });
    const coordinator = createQuitCoordinator({
      ...h.deps,
      hasRuntimeResources: () => true,
      closeRuntimes: () => new Promise(() => {}), // 永不落定
      runtimeCloseBudgetMs: 50,
    });
    coordinator.onBeforeQuit(event());
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();
    expect(h.quits).toHaveLength(1);
    expect(h.logs.some((line) => line.includes("runtime close budget"))).toBe(true);
  });

  it("closeRuntimes 抛错视同完成：仍然退出", async () => {
    const h = makeHarness({ inflight: false });
    const coordinator = createQuitCoordinator({
      ...h.deps,
      hasRuntimeResources: () => true,
      closeRuntimes: () => Promise.reject(new Error("close failed")),
    });
    coordinator.onBeforeQuit(event());
    await flushMicrotasks();
    expect(h.quits).toHaveLength(1);
    expect(h.logs.some((line) => line.includes("closeRuntimes failed"))).toBe(true);
  });

  it("无在飞轮且 server 从未起过（惰性未触发）→ 零成本路径不拦截", async () => {
    const h = makeHarness({ inflight: false });
    const coordinator = createQuitCoordinator({
      ...h.deps,
      hasRuntimeResources: () => false,
      closeRuntimes: () => Promise.resolve(),
    });
    const e = event();
    coordinator.onBeforeQuit(e);
    await flushMicrotasks();
    expect(e.prevented).toBe(0);
    expect(h.quits).toHaveLength(0); // 放行 Electron 自己退，我们不调 quit
    expect(coordinator.phase()).toBe("quitting");
  });
});
