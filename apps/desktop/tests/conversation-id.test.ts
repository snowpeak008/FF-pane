/**
 * T10.15b：对话编号计划、历史上限、Codex 记号拼接。
 */

import { noteWorkbenchConversation, WORKBENCH_CONVERSATION_LIMIT } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import { withCodexClaimMarker } from "../src/main/workbench/codex-claim";
import { planConversationLaunch } from "../src/renderer/src/pages/workbench/conversation-launch";

describe("planConversationLaunch", () => {
  it("开新对话不沿用旧编号", () => {
    expect(
      planConversationLaunch({
        action: "fresh",
        currentId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({ kind: "fresh" });
  });

  it("识别失败时续接当前走选择器", () => {
    expect(
      planConversationLaunch({
        action: "resume-current",
        currentId: "11111111-1111-4111-8111-111111111111",
        unidentified: true,
      }),
    ).toEqual({ kind: "picker" });
    expect(
      planConversationLaunch({
        action: "resume-current",
      }),
    ).toEqual({ kind: "picker" });
  });

  it("有编号时续接当前，历史选择用那一段的编号", () => {
    expect(
      planConversationLaunch({
        action: "resume-current",
        currentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ).toEqual({ kind: "resume", sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(
      planConversationLaunch({
        action: "resume-history",
        historyId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        unidentified: true,
      }),
    ).toEqual({ kind: "resume", sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
  });
});

describe("noteWorkbenchConversation", () => {
  it("同一编号只留一条，超过上限丢掉最久没活动的", () => {
    let history = noteWorkbenchConversation(undefined, "old", 1);
    history = noteWorkbenchConversation(history, "old", 5);
    expect(history).toEqual([{ id: "old", startedAt: 1, lastActiveAt: 5 }]);
    for (let i = 0; i < WORKBENCH_CONVERSATION_LIMIT; i += 1) {
      history = noteWorkbenchConversation(history, `id-${i}`, 10 + i);
    }
    expect(history).toHaveLength(WORKBENCH_CONVERSATION_LIMIT);
    expect(history.some((item) => item.id === "old")).toBe(false);
    expect(history[0]?.id).toBe(`id-${WORKBENCH_CONVERSATION_LIMIT - 1}`);
  });
});

describe("withCodexClaimMarker", () => {
  it("记号接在说明末尾，不是窗口令牌", () => {
    const marker = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    expect(withCodexClaimMarker("请用中文", marker)).toBe(`请用中文\nffpane-claim:${marker}`);
    expect(withCodexClaimMarker(undefined, marker)).toBe(`ffpane-claim:${marker}`);
  });
});
