/**
 * 习惯先行（T5.3，设计文档 §8.2.3）：有 workflow 流程约束时，Planner 收到一句话指令
 * 不立即给出最终产物，而是先据流程约束把指令整形成一份简短的分步方案（结构 → 请用户
 * 确认 → 再执行）。用户随时可说「直接做」单次跳过整形（习惯档案本身不失效）。
 *
 * 本模块是纯逻辑：判定"是否存在可用 workflow 习惯"、"本轮是否请求直接做"，以及提供
 * 追加到 Planner 提示词的整形指令文本。是否追加由编排器按角色/轮次类型决定。
 */

import type { HabitEntry } from "@ff-pane/shared";

/**
 * 习惯先行指令：仅在存在可用 workflow 流程约束且本轮未请求「直接做」时，
 * 由编排器追加到 planner 讨论轮的提示词末尾（放最末 = 最新、最高优先指令）。
 * 与编译产物（compileHabitProfile 的「## 流程约束（执行前必须遵守）」）配套。
 */
export const HABIT_FIRST_INSTRUCTION =
  "【习惯先行】你的『用户习惯』里包含流程约束（见上文「## 流程约束（执行前必须遵守）」）。" +
  "本轮请先遵循这些流程约束，把用户的指令整形为一份简短的分步方案——按习惯要求的结构与顺序，" +
  "说明你打算分几步推进（例如：先给结构/思路 → 请用户确认 → 再实现 → 最后验证），" +
  "并在方案末尾请用户确认后再进入下一步；不要越过流程约束直接给出最终产物或直接开始执行。";

/** 是否存在可用（active 且 enabled）的 workflow 习惯——习惯先行的触发前提。 */
export function hasActiveWorkflowHabit(habits: readonly HabitEntry[]): boolean {
  return habits.some((h) => h.category === "workflow" && h.status === "active" && h.enabled);
}

/**
 * 本轮用户是否请求「直接做」（单次跳过整形，§8.2.3）。
 * 约定：消息去空白后以「直接做」开头即视为跳过（如「直接做」「直接做吧」「直接做，别问了」）。
 * 保守匹配，避免把「直接做完 X 再…」这类讨论误判——仅认句首触发词。
 */
export function isDirectExecuteRequest(text: string): boolean {
  return text.trim().startsWith("直接做");
}
