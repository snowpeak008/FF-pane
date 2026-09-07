/**
 * T9.8 ② 上下文用量透出链路单测（store 归并侧）：
 * `context-usage` 事件按会话记账、末条覆盖、未认领轮弃置、新建会话/重置的清理语义。
 * 编排器发布侧（end.usage.contextTokens → context-usage 事件）见 session-orchestrator.test.ts。
 */

import type { LocalSessionId } from "@ff-pane/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { INITIAL_SESSION_UI_STATE, useSessionStore } from "../src/renderer/src/stores/session";
import type { SessionStreamEvent } from "../src/shared-ipc/contracts";

const SESSION_A = "sess-a" as LocalSessionId;
const SESSION_B = "sess-b" as LocalSessionId;

function started(turnId: string, sessionId: LocalSessionId): SessionStreamEvent {
  return { turnId, kind: "started", role: "planner", sessionId };
}

function contextUsage(
  turnId: string,
  usedTokens: number,
  windowTokens?: number,
): SessionStreamEvent {
  return {
    turnId,
    kind: "context-usage",
    usedTokens,
    ...(windowTokens !== undefined ? { windowTokens } : {}),
  };
}

function ingest(...events: readonly SessionStreamEvent[]): void {
  for (const event of events) {
    useSessionStore.getState().ingestSessionEvent(event);
  }
}

describe("context-usage 事件归并（T9.8 ②）", () => {
  beforeEach(() => {
    useSessionStore.setState(INITIAL_SESSION_UI_STATE);
  });

  it("按会话记账：两会话的用量各自独立", () => {
    ingest(started("t1", SESSION_A), started("t2", SESSION_B));
    ingest(contextUsage("t1", 10_000), contextUsage("t2", 52_000, 500_000));

    const usage = useSessionStore.getState().contextUsage;
    expect(usage.get(SESSION_A)).toEqual({ usedTokens: 10_000 });
    expect(usage.get(SESSION_B)).toEqual({ usedTokens: 52_000, windowTokens: 500_000 });
  });

  it("同会话新一轮覆盖旧值（最近一轮才是当前上下文规模）", () => {
    ingest(started("t1", SESSION_A), contextUsage("t1", 10_000, 400_000));
    ingest(started("t2", SESSION_A), contextUsage("t2", 90_000));

    // 覆盖是整条替换：旧的 windowTokens 不残留（新一轮没自报窗口就是没有）
    expect(useSessionStore.getState().contextUsage.get(SESSION_A)).toEqual({
      usedTokens: 90_000,
    });
  });

  it("未登记轮的事件忽略（陈旧事件不投毒）", () => {
    ingest(contextUsage("ghost", 10_000));
    expect(useSessionStore.getState().contextUsage.size).toBe(0);
  });

  it("end 之后用量保留（横幅在轮结束后才最有用——正是续接决策点）", () => {
    ingest(started("t1", SESSION_A), contextUsage("t1", 10_000));
    ingest({ turnId: "t1", kind: "end", reason: "completed" });
    expect(useSessionStore.getState().contextUsage.get(SESSION_A)).toEqual({
      usedTokens: 10_000,
    });
  });

  it("resetSessionUi 清空用量表（回到初始态）", () => {
    ingest(started("t1", SESSION_A), contextUsage("t1", 10_000));
    useSessionStore.getState().resetSessionUi();
    expect(useSessionStore.getState().contextUsage.size).toBe(0);
  });
});
