/**
 * 窗口启动时追加到角色提示末尾的语言要求与习惯。
 * 只进入该窗口自己的角色提示（Claude 临时文件 / Codex developer_instructions），不写 PTY。
 */

import type { HabitEntry } from "@ff-pane/shared";
import { isAiOutputLanguage } from "@ff-pane/shared";
import {
  compileHabitProfile,
  HABIT_PROMPT_MAX_CHARS,
  limitHabitProfileText,
} from "../habit/compile.js";
import { outputLanguageInstruction } from "../prompt/language.js";

export interface ComposeLaunchRolePromptInput {
  readonly rolePrompt: string;
  /** 设置页的值。不是具体语言（没设、跟随、无法识别）时不写。 */
  readonly outputLanguage?: string;
  readonly habits?: readonly HabitEntry[];
  /** 习惯段上限。缺省 {@link HABIT_PROMPT_MAX_CHARS}。 */
  readonly habitMaxChars?: number;
}

/** 具体语言才产生一句回复语言要求。 */
export function outputLanguagePromptSection(language: string | undefined): string | undefined {
  if (!isAiOutputLanguage(language)) {
    return undefined;
  }
  return `# 输出语言\n${outputLanguageInstruction(language)}`;
}

/**
 * 已通过且启用的习惯（compileHabitProfile 已过滤），超长则截断并说明。
 * 没有可写入的习惯时返回 undefined。
 */
export function habitPromptSection(
  habits: readonly HabitEntry[] | undefined,
  maxChars: number = HABIT_PROMPT_MAX_CHARS,
): string | undefined {
  if (habits === undefined || habits.length === 0) {
    return undefined;
  }
  const compiled = compileHabitProfile(habits);
  if (compiled === undefined) {
    return undefined;
  }
  return `# 用户习惯\n${limitHabitProfileText(compiled, maxChars)}`;
}

/** 角色提示 + 可选语言段 + 可选习惯段。没有额外内容时原样返回角色提示。 */
export function composeLaunchRolePrompt(input: ComposeLaunchRolePromptInput): string {
  const extras = [
    outputLanguagePromptSection(input.outputLanguage),
    habitPromptSection(input.habits, input.habitMaxChars),
  ].filter((section): section is string => section !== undefined);
  if (extras.length === 0) {
    return input.rolePrompt;
  }
  return [input.rolePrompt.trimEnd(), ...extras].join("\n\n");
}
