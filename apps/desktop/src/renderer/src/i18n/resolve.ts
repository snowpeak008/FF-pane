/**
 * UI 语言解析（纯逻辑，无浏览器/Electron 依赖，可直接单测）。
 * 解析顺序：用户已保存的选择 → 系统语言 → zh-CN 回退（项目设计计划 §9.1）。
 */

import { FALLBACK_UI_LANGUAGE, UI_LANGUAGES, type UiLanguage } from "@ff-pane/shared";

/**
 * 支持的界面语言。刻意复用领域层的 UI_LANGUAGES 而非再抄一份：
 * 两份同形清单并存时，只有被运行时消费的那份会被维护，另一份静默漂移。
 */
export const SUPPORTED_LANGUAGES = UI_LANGUAGES;

export type SupportedLanguage = UiLanguage;

/**
 * **解析回退**：用户没选过、系统语言又匹配不上任何语言包时用哪种界面语言。
 * 值与理由（2026-09-01 改为 zh-CN）见领域层 FALLBACK_UI_LANGUAGE。
 */
export const FALLBACK_LANGUAGE: SupportedLanguage = FALLBACK_UI_LANGUAGE;

export function isSupportedLanguage(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * 按优先级解析初始 UI 语言：
 * 1. saved —— 用户已保存的选择（非法值视同未保存）
 * 2. systemLocale —— 主进程 app.getLocale() 的系统语言（支持宽松匹配，如 zh / zh-TW → zh-CN）
 * 3. FALLBACK_LANGUAGE（zh-CN）
 */
export function resolveUiLanguage(saved: string | null, systemLocale: string): SupportedLanguage {
  return matchSupported(saved) ?? matchSupported(systemLocale) ?? FALLBACK_LANGUAGE;
}

/** 宽松匹配：忽略大小写与 _/- 差异，完整标签优先，其次按主语言子标签（zh-Hans-CN → zh-CN）。 */
function matchSupported(candidate: string | null): SupportedLanguage | undefined {
  if (candidate === null || candidate.trim() === "") {
    return undefined;
  }
  const normalized = candidate.trim().replaceAll("_", "-").toLowerCase();
  const exact = SUPPORTED_LANGUAGES.find((lang) => lang.toLowerCase() === normalized);
  if (exact !== undefined) {
    return exact;
  }
  const primary = normalized.split("-")[0] ?? normalized;
  return SUPPORTED_LANGUAGES.find((lang) => lang.toLowerCase().split("-")[0] === primary);
}
