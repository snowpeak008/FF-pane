/**
 * T10.9：续接确认后的启动去重。
 */

import { describe, expect, it } from "vitest";
import { createWindowLaunchGate } from "../src/main/workbench/launch-gate";
import { createRelaunchGuard } from "../src/renderer/src/pages/workbench/relaunch-guard";

describe("createWindowLaunchGate", () => {
  it("同一窗口进行中的第二次调用复用第一次，结束后可以再启动", async () => {
    const gate = createWindowLaunchGate();
    let started = 0;
    let release: (() => void) | undefined;
    const first = gate.run("win", () => {
      started += 1;
      return new Promise<string>((resolve) => {
        release = () => resolve("one");
      });
    });
    const second = gate.run("win", () => {
      started += 1;
      return Promise.resolve("two");
    });
    const other = gate.run("other", () => {
      started += 1;
      return Promise.resolve("other");
    });
    expect(started).toBe(2);
    expect(second).toBe(first);
    release?.();
    await expect(first).resolves.toBe("one");
    await expect(other).resolves.toBe("other");
    const third = gate.run("win", () => {
      started += 1;
      return Promise.resolve("three");
    });
    await expect(third).resolves.toBe("three");
    expect(started).toBe(3);
  });

  it("第一次拒绝后，第二次会再执行", async () => {
    const gate = createWindowLaunchGate();
    let started = 0;
    await expect(
      gate.run("win", () => {
        started += 1;
        return Promise.reject(new Error("boom"));
      }),
    ).rejects.toThrow("boom");
    await expect(
      gate.run("win", () => {
        started += 1;
        return Promise.resolve("ok");
      }),
    ).resolves.toBe("ok");
    expect(started).toBe(2);
  });
});

describe("createRelaunchGuard", () => {
  it("持有期间拒绝重入，离开后可以再进", () => {
    const guard = createRelaunchGuard();
    expect(guard.tryEnter()).toBe(true);
    expect(guard.tryEnter()).toBe(false);
    guard.leave();
    expect(guard.tryEnter()).toBe(true);
  });
});
