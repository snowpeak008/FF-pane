/**
 * 多语言设置（设计文档 §9）。
 * 两套独立机制：界面语言（§9.1）与 AI 输出语言（§9.2），互不影响。
 * 数据语言（§9.3）原样存储、不自动翻译，无需类型。
 */

import { createLiteralGuard } from "./common.js";

/** 设计文档 §9.1 —— 界面语言，首发两种；架构上支持随时增加语言包。 */
export const UI_LANGUAGES = ["zh-CN", "en-US"] as const;

/** 设计文档 §9.1 —— 界面语言代码。 */
export type UiLanguage = (typeof UI_LANGUAGES)[number];

/** UiLanguage 运行时守卫。 */
export const isUiLanguage = createLiteralGuard(UI_LANGUAGES);

/** 设计文档 §9.1 —— 无匹配语言包时的回退语言。 */
export const FALLBACK_UI_LANGUAGE: UiLanguage = "en-US";

/**
 * 设计文档 §9.1 —— 界面语言设置项。
 * "system" 表示跟随操作系统语言（默认值），解析失败回退 FALLBACK_UI_LANGUAGE。
 */
export const UI_LANGUAGE_SETTINGS = ["system", ...UI_LANGUAGES] as const;

/** 设计文档 §9.1 —— 界面语言设置值。 */
export type UiLanguageSetting = (typeof UI_LANGUAGE_SETTINGS)[number];

/** UiLanguageSetting 运行时守卫。 */
export const isUiLanguageSetting = createLiteralGuard(UI_LANGUAGE_SETTINGS);

/**
 * 设计文档 §9.2 —— AI 输出语言，与界面语言解耦。
 * 首发集合与界面语言相同，但两个常量刻意独立：新增 AI 输出语言无需语言包。
 */
export const AI_OUTPUT_LANGUAGES = ["zh-CN", "en-US"] as const;

/** 设计文档 §9.2 —— AI 输出语言代码。 */
export type AiOutputLanguage = (typeof AI_OUTPUT_LANGUAGES)[number];

/** AiOutputLanguage 运行时守卫。 */
export const isAiOutputLanguage = createLiteralGuard(AI_OUTPUT_LANGUAGES);

/**
 * 设计文档 §9.2 —— AI 输出语言的三级设置（低层覆盖高层）：
 * 全局默认 → Agent Profile → 项目。
 * Profile 层与项目层为可选覆盖，字段缺省即"继承上一级"（不引入 "inherit" 字面量，
 * 缺省语义更简单且与 JSON 持久化天然一致）。级联求值属 Prompt 组装层（T4.1）。
 */
export interface AiOutputLanguageSettings {
  /** 设计文档 §9.2 —— 全局默认 AI 输出语言（设置页）。 */
  readonly global: AiOutputLanguage;
  /** 设计文档 §9.2 —— 单个 Agent Profile 的输出语言覆盖。 */
  readonly profile?: AiOutputLanguage;
  /** 设计文档 §9.2 —— 单个项目的输出语言覆盖（最高优先级）。 */
  readonly project?: AiOutputLanguage;
}
