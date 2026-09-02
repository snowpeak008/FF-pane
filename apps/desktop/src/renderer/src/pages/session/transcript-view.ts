/**
 * 回放本 → 消息视图模型（T8.2b-b）。与 React 无关，便于单测。
 *
 * 映射规则：
 * - `user_message` / `assistant_message` 按文件顺序映射为消息，`turn_end` 本身不成为消息；
 * - 被中断轮次的标注有两个来源：`assistant_message{partial:true}`（有部分文本）与
 *   `turn_end{endReason:"interrupted"}`（无部分文本时唯一的证据）——后者若找不到本轮的
 *   assistant 消息，就补一条空文本的标注占位消息，保证「这一轮被打断了」在消息流里可见；
 * - 同 turnId 同侧只留第一条（回放本 append-only，正常不会重复；坏数据防御，
 *   也是「回放 + 在飞去重」的同一原则在文件内的应用）。
 */

import type { TranscriptEntry } from "@ff-pane/shared";
import type { SessionHistoryMessage } from "../../stores/session";

export function mapTranscriptToMessages(
  entries: readonly TranscriptEntry[],
): readonly SessionHistoryMessage[] {
  const out: SessionHistoryMessage[] = [];
  const seen = new Set<string>();
  const assistantIndex = new Map<string, number>();
  const interruptedTurns = new Set<string>();

  for (const entry of entries) {
    if (entry.kind === "user_message") {
      const key = `user:${entry.turnId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({
        id: `${entry.turnId}:user`,
        turnId: entry.turnId,
        role: "user",
        text: entry.text,
      });
    } else if (entry.kind === "assistant_message") {
      const key = `assistant:${entry.turnId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      assistantIndex.set(entry.turnId, out.length);
      if (entry.partial === true) {
        interruptedTurns.add(entry.turnId);
      }
      out.push({
        id: `${entry.turnId}:assistant`,
        turnId: entry.turnId,
        role: "assistant",
        text: entry.text,
        ...(entry.partial === true ? { interrupted: true as const } : {}),
      });
    } else if (entry.endReason === "interrupted" && !interruptedTurns.has(entry.turnId)) {
      interruptedTurns.add(entry.turnId);
      const index = assistantIndex.get(entry.turnId);
      const existing = index !== undefined ? out[index] : undefined;
      if (index !== undefined && existing !== undefined) {
        out[index] = { ...existing, interrupted: true };
      } else {
        out.push({
          id: `${entry.turnId}:interrupted`,
          turnId: entry.turnId,
          role: "assistant",
          text: "",
          interrupted: true,
        });
      }
    }
  }
  return out;
}
