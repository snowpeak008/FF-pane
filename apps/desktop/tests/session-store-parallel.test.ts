/**
 * T8.3b 渲染层多轮并发单测：activeTurns Map 的分桶归并（按 turnId，不再忽略非当前轮）、
 * busy 语义（sessionBusy = 当前会话有在飞轮）、per-turn 权限队列与按 turnId 回执、
 * 跨会话轮的 fold 隔离（别的会话的轮结束不进当前 historyMessages 但计入 endedTurnSeq）、
 * 状态条派生（sessionStatusView）。与仓内款式一致：zustand store 直测，无 @testing-library。
 */

import type { LocalSessionId } from "@ff-pane/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  currentSessionTurns,
  INITIAL_SESSION_UI_STATE,
  pendingPermissionsOf,
  sessionBusy,
  sessionStatusView,
  useSessionStore,
} from "../src/renderer/src/stores/session";
import type { SessionStreamEvent } from "../src/shared-ipc/contracts";

const SESSION_A = "sess-a" as LocalSessionId;
const SESSION_B = "sess-b" as LocalSessionId;

function started(
  turnId: string,
  sessionId: LocalSessionId,
  role: "planner" | "worker" | "reviewer" = "planner",
): SessionStreamEvent {
  return { turnId, kind: "started", role, sessionId };
}

function text(turnId: string, delta: string): SessionStreamEvent {
  return { turnId, kind: "text", channel: "answer", delta, final: false };
}

function end(turnId: string): SessionStreamEvent {
  return { turnId, kind: "end", reason: "completed" };
}

function ingest(...events: readonly SessionStreamEvent[]): void {
  for (const event of events) {
    useSessionStore.getState().ingestSessionEvent(event);
  }
}

describe("session store 多轮并发（T8.3b）", () => {
  beforeEach(() => {
    useSessionStore.setState(INITIAL_SESSION_UI_STATE);
  });

  it("两轮并发流式：text 事件按 turnId 各自累积，互不覆盖", () => {
    ingest(started("t1", SESSION_A), started("t2", SESSION_B, "worker"));
    ingest(text("t1", "甲说"), text("t2", "乙说"), text("t1", "一"), text("t2", "二"));

    const s = useSessionStore.getState();
    expect(s.activeTurns.size).toBe(2);
    expect(s.activeTurns.get("t1")?.text).toBe("甲说一");
    expect(s.activeTurns.get("t2")?.text).toBe("乙说二");
  });

  it("busy 语义：当前会话有在飞轮才忙，别的会话的并发轮不锁本会话", () => {
    ingest(started("t1", SESSION_A));
    // started 把 activeSessionId 切到最后开始的轮（派发即进入执行视图）
    ingest(started("t2", SESSION_B, "worker"));
    const s = useSessionStore.getState();
    expect(s.activeSessionId).toBe(SESSION_B);
    expect(sessionBusy(s.activeTurns, SESSION_B)).toBe(true);
    // 会话 A 也有在飞轮 → 忙；一个两轮都不在的会话不忙
    expect(sessionBusy(s.activeTurns, SESSION_A)).toBe(true);
    expect(sessionBusy(s.activeTurns, "sess-idle" as LocalSessionId)).toBe(false);

    ingest(end("t2"));
    expect(sessionBusy(useSessionStore.getState().activeTurns, SESSION_B)).toBe(false);
    expect(sessionBusy(useSessionStore.getState().activeTurns, SESSION_A)).toBe(true);
  });

  it("fold 隔离：当前会话的轮结束固化进历史，别的会话的轮结束不混入但计入 endedTurnSeq", () => {
    ingest(started("t1", SESSION_A), started("t2", SESSION_B, "worker"));
    ingest(text("t1", "A 的回答"), text("t2", "B 的报告"));
    // 当前视图是 SESSION_B（最后 started）；先结束 A 的轮
    ingest(end("t1"));
    let s = useSessionStore.getState();
    expect(s.endedTurnSeq).toBe(1);
    expect(s.historyMessages).toEqual([]); // A 不是当前会话，不进当前视图
    // 再结束 B 的轮：进历史
    ingest(end("t2"));
    s = useSessionStore.getState();
    expect(s.endedTurnSeq).toBe(2);
    expect(s.historyMessages).toEqual([
      { id: "t2:assistant", turnId: "t2", role: "assistant", text: "B 的报告" },
    ]);
    expect(s.activeTurns.size).toBe(0);
  });

  it("per-turn 权限队列：两轮同时 blocked 各自一条，按 turnId 回执只清那一条", () => {
    ingest(started("t1", SESSION_A), started("t2", SESSION_B, "worker"));
    ingest(
      { turnId: "t1", kind: "permission-request", requestId: "r1", summary: "写入文件 a" },
      { turnId: "t2", kind: "permission-request", requestId: "r2", summary: "写入文件 b" },
    );
    let pendings = pendingPermissionsOf(useSessionStore.getState().activeTurns);
    expect(pendings.map((p) => [p.turnId, p.requestId])).toEqual([
      ["t1", "r1"],
      ["t2", "r2"],
    ]);

    useSessionStore.getState().clearPendingPermission("t1");
    pendings = pendingPermissionsOf(useSessionStore.getState().activeTurns);
    expect(pendings.map((p) => p.turnId)).toEqual(["t2"]);
    // t2 的轮仍在飞、其待批不受 t1 回执影响
    expect(useSessionStore.getState().activeTurns.get("t2")?.pendingPermission).not.toBeNull();
  });

  it("状态条派生：当前会话最新在飞轮优先（含 awaiting），无在飞轮退回最近结束摘要", () => {
    ingest(started("t1", SESSION_A, "worker"));
    let view = sessionStatusView(
      useSessionStore.getState().activeTurns,
      SESSION_A,
      useSessionStore.getState().lastEndedView,
    );
    expect(view).toMatchObject({ role: "worker", status: "running" });

    ingest({ turnId: "t1", kind: "permission-request", requestId: "r1", summary: "s" });
    view = sessionStatusView(useSessionStore.getState().activeTurns, SESSION_A, null);
    expect(view.status).toBe("awaiting-permission");

    ingest(text("t1", "ok"), end("t1"));
    const s = useSessionStore.getState();
    view = sessionStatusView(s.activeTurns, SESSION_A, s.lastEndedView);
    expect(view).toMatchObject({ role: "worker", status: "ended" });
  });

  it("failLocalTurn：被拒轮直接移出在飞表，不留占位、不动历史", () => {
    const store = useSessionStore.getState();
    store.startLocalTurn("rejected", "worker");
    expect(useSessionStore.getState().activeTurns.has("rejected")).toBe(true);
    store.failLocalTurn("rejected", "可写范围相交");
    const s = useSessionStore.getState();
    expect(s.activeTurns.size).toBe(0);
    expect(s.historyMessages).toEqual([]);
  });

  it("未登记轮的迟到事件被忽略（结束后的增量不复活轮）", () => {
    ingest(started("t1", SESSION_A), text("t1", "hi"), end("t1"));
    ingest(text("t1", "迟到"));
    expect(useSessionStore.getState().activeTurns.size).toBe(0);
  });

  it("currentSessionTurns：未被 started 认领的本地轮（sessionId=null）计入当前视图", () => {
    // 本页刚发起、ack 未返回：轮的 sessionId 未知，busy 必须立刻为真（不漏窗口期）
    useSessionStore.getState().startLocalTurn("pending-ack", "planner");
    const s = useSessionStore.getState();
    expect(currentSessionTurns(s.activeTurns, null)).toHaveLength(1);
    expect(sessionBusy(s.activeTurns, null)).toBe(true);
  });
});
