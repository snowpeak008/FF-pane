/**
 * T8.2b-b 会话回放渲染层单测：回放本 → 消息视图映射（中断标注 / turnId 去重）、
 * 续接方式预判（唯一一份 + 源码守卫）、store 的回放载入 / fold-on-end 合流去重 /
 * 新建会话重置。与仓内款式一致：无 @testing-library，纯逻辑 + zustand store 直测 +
 * 读源码守卫。
 */

import { readFileSync } from "node:fs";
import type {
  LocalSessionId,
  ProfileId,
  RunEndReason,
  SessionRecord,
  TranscriptEntry,
} from "@ff-pane/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { predictResumeKind } from "../src/renderer/src/pages/session/resume-view";
import { mapTranscriptToMessages } from "../src/renderer/src/pages/session/transcript-view";
import {
  foldEndedTurn,
  INITIAL_SESSION_UI_STATE,
  type SessionHistoryMessage,
  useSessionStore,
} from "../src/renderer/src/stores/session";

const SESSION = "sess-1" as LocalSessionId;

function userMsg(turnId: string, text: string, at = 1): TranscriptEntry {
  return { kind: "user_message", turnId, at, text };
}

function assistantMsg(
  turnId: string,
  text: string,
  options: { readonly partial?: true; readonly at?: number } = {},
): TranscriptEntry {
  return {
    kind: "assistant_message",
    turnId,
    at: options.at ?? 2,
    text,
    ...(options.partial === true ? { partial: true } : {}),
  };
}

function turnEnd(turnId: string, endReason: RunEndReason, at = 3): TranscriptEntry {
  return {
    kind: "turn_end",
    turnId,
    at,
    role: "planner",
    profileId: "prof-1" as ProfileId,
    endReason,
  };
}

describe("mapTranscriptToMessages", () => {
  it("user / assistant 交替映射为消息，turn_end 本身不出现", () => {
    const messages = mapTranscriptToMessages([
      userMsg("t1", "你好"),
      assistantMsg("t1", "在的"),
      turnEnd("t1", "completed"),
      userMsg("t2", "继续"),
      assistantMsg("t2", "好的"),
      turnEnd("t2", "completed"),
    ]);
    expect(messages).toEqual([
      { id: "t1:user", turnId: "t1", role: "user", text: "你好" },
      { id: "t1:assistant", turnId: "t1", role: "assistant", text: "在的" },
      { id: "t2:user", turnId: "t2", role: "user", text: "继续" },
      { id: "t2:assistant", turnId: "t2", role: "assistant", text: "好的" },
    ]);
  });

  it("assistant_message{partial} → 中断标注", () => {
    const messages = mapTranscriptToMessages([
      userMsg("t1", "做点什么"),
      assistantMsg("t1", "我做到一半", { partial: true }),
      turnEnd("t1", "interrupted"),
    ]);
    expect(messages[1]).toEqual({
      id: "t1:assistant",
      turnId: "t1",
      role: "assistant",
      text: "我做到一半",
      interrupted: true,
    });
    // partial 与 turn_end{interrupted} 同轮出现时不产生第二条标注
    expect(messages.filter((m) => m.turnId === "t1" && m.role === "assistant")).toHaveLength(1);
  });

  it("turn_end{interrupted} 且本轮无 assistant 文本 → 补空文本标注占位消息", () => {
    const messages = mapTranscriptToMessages([
      userMsg("t1", "刚说完就关了"),
      turnEnd("t1", "interrupted"),
    ]);
    expect(messages).toEqual([
      { id: "t1:user", turnId: "t1", role: "user", text: "刚说完就关了" },
      { id: "t1:interrupted", turnId: "t1", role: "assistant", text: "", interrupted: true },
    ]);
  });

  it("turn_end{interrupted} 且本轮已有（非 partial 的）assistant 消息 → 就地标注不另起一条", () => {
    const messages = mapTranscriptToMessages([
      userMsg("t1", "q"),
      assistantMsg("t1", "answer"),
      turnEnd("t1", "interrupted"),
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ id: "t1:assistant", interrupted: true });
  });

  it("非 interrupted 的 turn_end（failed / cancelled）不产生消息也不标注", () => {
    const messages = mapTranscriptToMessages([
      userMsg("t1", "q"),
      assistantMsg("t1", "a"),
      turnEnd("t1", "failed"),
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[1]).not.toHaveProperty("interrupted");
  });

  it("同 turnId 同侧去重：重复条目只留第一条", () => {
    const messages = mapTranscriptToMessages([
      userMsg("t1", "first"),
      userMsg("t1", "duplicate"),
      assistantMsg("t1", "a1"),
      assistantMsg("t1", "a2"),
    ]);
    expect(messages).toEqual([
      { id: "t1:user", turnId: "t1", role: "user", text: "first" },
      { id: "t1:assistant", turnId: "t1", role: "assistant", text: "a1" },
    ]);
  });
});

describe("predictResumeKind", () => {
  function record(native: boolean): SessionRecord {
    return {
      id: SESSION,
      profileId: "prof-1",
      role: "planner",
      createdAt: 1,
      lastActiveAt: 2,
      ...(native ? { native: { nativeSessionId: "n-1", cwd: "C:\\p" } } : {}),
    } as unknown as SessionRecord;
  }

  it("有原生绑定 → native；无 → context_rebuild", () => {
    expect(predictResumeKind(record(true))).toBe("native");
    expect(predictResumeKind(record(false))).toBe("context_rebuild");
  });

  it("守卫：预判逻辑全仓只有 resume-view.ts 一份（Panel 与横幅只准消费，不准内联）", () => {
    const dir = new URL("../src/renderer/src/pages/session/", import.meta.url);
    const panel = readFileSync(new URL("SessionResumePanel.tsx", dir), "utf8");
    const banner = readFileSync(new URL("SessionReplayBanner.tsx", dir), "utf8");
    const page = readFileSync(new URL("SessionPage.tsx", dir), "utf8");
    for (const [name, source] of [
      ["SessionResumePanel", panel],
      ["SessionReplayBanner", banner],
      ["SessionPage", page],
    ] as const) {
      expect(source, `${name} 不得内联 native 判定，须经 predictResumeKind`).not.toMatch(
        /native\s*!==?\s*undefined/,
      );
    }
    expect(panel).toContain("predictResumeKind");
  });
});

describe("session store 回放与合流（T8.2b-b）", () => {
  beforeEach(() => {
    useSessionStore.setState(INITIAL_SESSION_UI_STATE);
  });

  const replayMessages: readonly SessionHistoryMessage[] = [
    { id: "t1:user", turnId: "t1", role: "user", text: "hi" },
    { id: "t1:assistant", turnId: "t1", role: "assistant", text: "hello" },
  ];

  function loadReplay(): void {
    useSessionStore.getState().loadReplay({
      projectRoot: "C:\\proj",
      replay: { sessionId: SESSION, predictedKind: "context_rebuild", skippedLines: 2 },
      messages: replayMessages,
    });
  }

  it("loadReplay：设当前会话 + 历史消息 + 横幅上下文 + 项目已处理", () => {
    loadReplay();
    const s = useSessionStore.getState();
    expect(s.activeSessionId).toBe(SESSION);
    expect(s.historyMessages).toEqual(replayMessages);
    expect(s.replay).toEqual({
      sessionId: SESSION,
      predictedKind: "context_rebuild",
      skippedLines: 2,
    });
    expect(s.autoResumeDoneRoot).toBe("C:\\proj");
  });

  it("loadReplay 在有在飞轮时不覆盖现场，只记项目已处理", () => {
    useSessionStore.getState().startLocalTurn("live", "planner", "用户正在聊");
    loadReplay();
    const s = useSessionStore.getState();
    expect(s.activeSessionId).toBeNull();
    expect(s.replay).toBeNull();
    expect(s.activeTurns.get("live")?.turnId).toBe("live");
    expect(s.autoResumeDoneRoot).toBe("C:\\proj");
  });

  it("startLocalTurn 带用户文本 → 追加进历史（回放后新发言接在其后）", () => {
    loadReplay();
    useSessionStore.getState().startLocalTurn("t2", "planner", "接着说");
    const s = useSessionStore.getState();
    expect(s.historyMessages.at(-1)).toEqual({
      id: "t2:user",
      turnId: "t2",
      role: "user",
      text: "接着说",
    });
    expect(s.activeTurns.has("t2")).toBe(true);
  });

  it("fold-on-end：end 事件把在飞轮固化进历史并移出在飞表，同 turnId 不双份", () => {
    loadReplay();
    const store = useSessionStore.getState();
    store.startLocalTurn("t2", "planner", "问题");
    store.ingestSessionEvent({
      turnId: "t2",
      kind: "text",
      channel: "answer",
      delta: "回答",
      final: false,
    });
    store.ingestSessionEvent({ turnId: "t2", kind: "end", reason: "completed" });

    const s = useSessionStore.getState();
    expect(s.activeTurns.size).toBe(0);
    const t2Assistant = s.historyMessages.filter(
      (m) => m.turnId === "t2" && m.role === "assistant",
    );
    expect(t2Assistant).toEqual([
      { id: "t2:assistant", turnId: "t2", role: "assistant", text: "回答" },
    ]);
    // 回放的历史仍在最前，未被覆盖
    expect(s.historyMessages.slice(0, 2)).toEqual(replayMessages);
  });

  it("fold-on-end：无 answer 文本的轮不固化空消息；interrupted 结束带中断标注", () => {
    const store = useSessionStore.getState();
    store.startLocalTurn("empty", "planner");
    store.ingestSessionEvent({ turnId: "empty", kind: "end", reason: "failed" });
    expect(useSessionStore.getState().historyMessages).toEqual([]);

    store.startLocalTurn("cut", "planner");
    store.ingestSessionEvent({
      turnId: "cut",
      kind: "text",
      channel: "answer",
      delta: "说了一半",
      final: false,
    });
    store.ingestSessionEvent({ turnId: "cut", kind: "end", reason: "interrupted" });
    expect(useSessionStore.getState().historyMessages).toEqual([
      {
        id: "cut:assistant",
        turnId: "cut",
        role: "assistant",
        text: "说了一半",
        interrupted: true,
      },
    ]);
  });

  it("foldEndedTurn 直调：同 turnId 已有 assistant 条目时第二次固化不追加（去重守卫，T8.2b-b 验收 §3-1）", () => {
    // 直调而非走事件链路：链路上重复 end 会被 ingestSessionEvent 的归属判定挡掉，
    // 该守卫是防御码，只有直调两次才能让"删守卫必红"成立（验收探针③的补测）。
    const turn = { turnId: "t1", text: "答复" } as const;
    const once = foldEndedTurn([], turn, "completed");
    expect(once).toEqual([{ id: "t1:assistant", turnId: "t1", role: "assistant", text: "答复" }]);
    const twice = foldEndedTurn(once, { ...turn, text: "迟到的重复 end" }, "completed");
    expect(twice).toEqual(once);
  });

  it("startNewSession：清空会话 / 历史 / 横幅，但保留 autoResumeDoneRoot", () => {
    loadReplay();
    useSessionStore.getState().startNewSession();
    const s = useSessionStore.getState();
    expect(s.activeSessionId).toBeNull();
    expect(s.historyMessages).toEqual([]);
    expect(s.replay).toBeNull();
    // 用户显式要求新会话：自动续接不得再把它拉回旧会话
    expect(s.autoResumeDoneRoot).toBe("C:\\proj");
  });
});
