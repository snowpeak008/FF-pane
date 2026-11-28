/**
 * T11.1b §5：监管者收到提醒 15 分钟后窗口还是同一种状态，交给调用方报管理者。
 */

import { describe, expect, it } from "vitest";
import {
  buildSupervisorUnhandledLine,
  createSupervisorHandleWatch,
  SUPERVISOR_HANDLE_GRACE_MS,
} from "../src/main/workbench/supervisor-handle-watch";

const entry = { windowId: "w1", managerId: "m1", stateKey: "blocked", what: "在等用户批准。" };

describe("监管者没处理好的兜底", () => {
  it("不到 15 分钟不交出；到点状态没变就交出一次", () => {
    let now = 0;
    const watch = createSupervisorHandleWatch({ now: () => now });
    watch.note(entry);
    now = SUPERVISOR_HANDLE_GRACE_MS - 1;
    expect(watch.takeDue(() => "blocked")).toEqual([]);
    now = SUPERVISOR_HANDLE_GRACE_MS;
    expect(watch.takeDue(() => "blocked")).toEqual([entry]);
    expect(watch.takeDue(() => "blocked")).toEqual([]);
  });

  it("到点时状态变了或窗口没了：不交出，也不再记着", () => {
    let now = 0;
    const watch = createSupervisorHandleWatch({ now: () => now, graceMs: 100 });
    watch.note(entry);
    watch.note({ ...entry, windowId: "w2" });
    now = 100;
    const due = watch.takeDue((id) => (id === "w1" ? "idle" : undefined));
    expect(due).toEqual([]);
    expect(watch.takeDue(() => "blocked")).toEqual([]);
  });

  it("同一种状态重复记不重置时间；状态变了重新计时", () => {
    let now = 0;
    const watch = createSupervisorHandleWatch({ now: () => now, graceMs: 100 });
    watch.note(entry);
    now = 60;
    watch.note(entry);
    now = 100;
    expect(watch.takeDue(() => "blocked")).toEqual([entry]);

    const next = { ...entry, stateKey: "idle" };
    now = 200;
    watch.note(entry);
    now = 250;
    watch.note(next);
    now = 300;
    expect(watch.takeDue(() => "idle")).toEqual([]);
    now = 350;
    expect(watch.takeDue(() => "idle")).toEqual([next]);
  });

  it("窗口关了就忘掉", () => {
    let now = 0;
    const watch = createSupervisorHandleWatch({ now: () => now, graceMs: 10 });
    watch.note(entry);
    watch.forget("w1");
    now = 10;
    expect(watch.takeDue(() => "blocked")).toEqual([]);
  });

  it("报管理者的话是一行，以「[状态]」开头", () => {
    const line = buildSupervisorUnhandledLine("执行甲", "w1", "在等用户批准。");
    expect(line.startsWith("[状态]")).toBe(true);
    expect(line).toContain("15 分钟");
    expect(line).toContain("w1");
    expect(line).not.toContain("\n");
  });
});
