/**
 * AI 输出语言三级取值与指令（设计文档 §9.2）：全局默认 → Profile 覆盖 → 项目覆盖，
 * 低层覆盖高层，缺省即继承上一级。级联结果转成一句提示指令进 Prompt。
 */

import type { AiOutputLanguage, AiOutputLanguageSettings } from "@ff-pane/shared";

/** 三级级联求值：项目 > Profile > 全局（缺省继承上一级）。 */
export function resolveOutputLanguage(settings: AiOutputLanguageSettings): AiOutputLanguage {
  return settings.project ?? settings.profile ?? settings.global;
}

/** 语言代码 → 提示词里用的语言名（发给 Agent，非 UI 文案）。 */
const LANGUAGE_NAME: Readonly<Record<AiOutputLanguage, string>> = {
  "zh-CN": "简体中文",
  "en-US": "English",
};

/** 输出语言指令：一句话约束 Agent 的回复语言。 */
export function outputLanguageInstruction(language: AiOutputLanguage): string {
  return `请始终用${LANGUAGE_NAME[language]}回复（代码、命令、专有名词保持原样）。`;
}
