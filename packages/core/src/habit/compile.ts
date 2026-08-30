/**
 * 习惯档案编译器（T5.2，设计文档 §8.2.2）：把 active 习惯条目编译成 Prompt 第 2 层
 * 的一段紧凑指令文本。任何习惯条目变更后自动重新编译（编排器每轮调用，纯函数无缓存）。
 *
 * 规则（§8.2.2）：
 * - 只取 status=active 且 enabled=true 的条目（停用 / 候选 / 归档不进 Prompt）。
 * - 按类别分组，类别顺序 workflow → tech → communication → environment（workflow 先行，
 *   因为它是"执行前必须遵守的流程约束"）；组内按 importance 降序（同值 updatedAt 降序、
 *   id 升序，保证可快照）。
 * - workflow 组显式标注为"执行前必须遵守的流程约束"（§8.2.2 / §8.2.3 习惯先行的依据）。
 * - 无任何可用条目时返回 undefined，让 assemblePrompt 的第 2 层落到"（暂无）"占位。
 *
 * 返回的是 `# 用户习惯` 段的正文（不含该标题——标题由 assemblePrompt 负责）。
 */

import type { HabitCategory, HabitEntry } from "@ff-pane/shared";
import { HABIT_CATEGORIES } from "@ff-pane/shared";

/** 类别 → Prompt 内的分组小标题（发给 Agent 的提示词，非 UI 文案，不进语言包）。 */
const HABIT_CATEGORY_HEADINGS: Readonly<Record<HabitCategory, string>> = {
  workflow: "流程约束（执行前必须遵守）",
  tech: "技术偏好",
  communication: "沟通偏好",
  environment: "环境经验",
};

/** 组内排序：importance 降序 → updatedAt 降序 → id 升序（稳定、可快照）。 */
function compareForCompile(a: HabitEntry, b: HabitEntry): number {
  if (a.importance !== b.importance) {
    return b.importance - a.importance;
  }
  if (a.updatedAt !== b.updatedAt) {
    return b.updatedAt - a.updatedAt;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 编译习惯档案文本。仅取 active + enabled 条目，按类别分组渲染。
 * 无可用条目返回 undefined（第 2 层落占位）。
 */
export function compileHabitProfile(habits: readonly HabitEntry[]): string | undefined {
  const usable = habits.filter((h) => h.status === "active" && h.enabled);
  if (usable.length === 0) {
    return undefined;
  }

  const blocks: string[] = [];
  for (const category of HABIT_CATEGORIES) {
    const group = usable.filter((h) => h.category === category).sort(compareForCompile);
    if (group.length === 0) {
      continue;
    }
    const lines = group.map((h) => `- ${h.content.trim()}`);
    blocks.push(`## ${HABIT_CATEGORY_HEADINGS[category]}\n${lines.join("\n")}`);
  }

  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}
