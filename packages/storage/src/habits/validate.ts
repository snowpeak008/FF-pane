/**
 * 习惯草稿结构校验（T5.1）：设计文档 §8.2。习惯记忆权限极高（跨项目、直接进
 * Prompt 组装），故落盘前强制校验。与 providers/validate.ts 同款：快速失败、
 * 抛带字段名的 HabitValidationError；也可供上层（IPC / 界面）提交前独立调用。
 */

import type { HabitEntry } from "@ff-pane/shared";
import { isHabitCategory, isHabitSourceKind, isMemoryStatus } from "@ff-pane/shared";
import { HabitValidationError } from "./errors.js";

/** 习惯指令文本最大长度（§8.2：习惯是小而精的短文本，非资料）。 */
export const HABIT_CONTENT_MAX_LENGTH = 500;

/** importance 取值区间（编译排序依据，值大者先渲染）。 */
export const HABIT_IMPORTANCE_MIN = 0;
export const HABIT_IMPORTANCE_MAX = 100;

/** 创建 / 更新习惯时调用方提交的内容：除 id / 时间戳（store 生成）外的全部字段。 */
export type HabitDraft = Omit<HabitEntry, "id" | "createdAt" | "updatedAt">;

/**
 * 校验习惯草稿（create / update 共用），违规抛带字段名的 HabitValidationError。
 * 字面量联合字段用 shared 的运行时守卫复核，覆盖 IPC / JSON 边界传入未收窄数据。
 */
export function validateHabitDraft(draft: HabitDraft): void {
  if (!isHabitCategory(draft.category)) {
    throw new HabitValidationError("category", `未知的习惯分类：${String(draft.category)}`);
  }

  if (typeof draft.content !== "string" || draft.content.trim() === "") {
    throw new HabitValidationError("content", "习惯指令文本不能为空");
  }
  if (draft.content.length > HABIT_CONTENT_MAX_LENGTH) {
    throw new HabitValidationError(
      "content",
      `习惯指令文本过长（${draft.content.length} > ${HABIT_CONTENT_MAX_LENGTH}）`,
    );
  }

  if (!isMemoryStatus(draft.status)) {
    throw new HabitValidationError("status", `未知的状态：${String(draft.status)}`);
  }

  if (typeof draft.enabled !== "boolean") {
    throw new HabitValidationError("enabled", "enabled 必须为布尔值");
  }

  if (
    typeof draft.importance !== "number" ||
    !Number.isFinite(draft.importance) ||
    draft.importance < HABIT_IMPORTANCE_MIN ||
    draft.importance > HABIT_IMPORTANCE_MAX
  ) {
    throw new HabitValidationError(
      "importance",
      `重要度必须是 ${HABIT_IMPORTANCE_MIN}~${HABIT_IMPORTANCE_MAX} 的数字`,
    );
  }

  if (!isHabitSourceKind(draft.source.kind)) {
    throw new HabitValidationError("source", `未知的来源类别：${String(draft.source.kind)}`);
  }
  if (draft.source.kind === "distilled") {
    if (typeof draft.source.sourceProject !== "string" || draft.source.sourceProject === "") {
      throw new HabitValidationError("source", "distilled 来源必须携带 sourceProject（溯源）");
    }
    if (typeof draft.source.sourceEntryId !== "string" || draft.source.sourceEntryId === "") {
      throw new HabitValidationError("source", "distilled 来源必须携带 sourceEntryId（溯源）");
    }
  }
}
