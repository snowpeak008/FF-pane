/**
 * UI 语言解析（纯逻辑，无浏览器/Electron 依赖，可直接单测）。
 * 解析顺序：用户已保存的选择 → 系统语言 → zh-CN 回退（项目设计计划 §9.1）。
 */

import {
  FALLBACK_UI_LANGUAGE,
  isUiLanguageSetting,
  UI_LANGUAGE_SETTINGS,
  UI_LANGUAGES,
  type UiLanguage,
  type UiLanguageSetting,
} from "@ff-pane/shared";

/**
 * 支持的界面语言。刻意复用领域层的 UI_LANGUAGES 而非再抄一份：
 * 两份同形清单并存时，只有被运行时消费的那份会被维护，另一份静默漂移。
 */
export const SUPPORTED_LANGUAGES = UI_LANGUAGES;

export type SupportedLanguage = UiLanguage;

/**
 * 界面语言的**设置值**三态：跟随系统 + 两种具体语言（领域层 UI_LANGUAGE_SETTINGS）。
 * 与 SupportedLanguage 的区别：那是"最终显示哪种语言"，这是"用户选了什么"——
 * 选了「跟随系统」时显示哪种语言取决于系统，不是一个固定值。
 */
export const LANGUAGE_SETTINGS = UI_LANGUAGE_SETTINGS;

export type LanguageSetting = UiLanguageSetting;

/** 未保存过选择时的默认设置：跟随系统（与主题偏好同一先例，见 theme/resolve.ts）。 */
export const DEFAULT_LANGUAGE_SETTING: LanguageSetting = "system";

/**
 * **解析回退**：用户没选过、系统语言又匹配不上任何语言包时用哪种界面语言。
 * 值与理由（2026-09-01 改为 zh-CN）见领域层 FALLBACK_UI_LANGUAGE。
 */
export const FALLBACK_LANGUAGE: SupportedLanguage = FALLBACK_UI_LANGUAGE;

export function isSupportedLanguage(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * 解析持久化的设置值：合法值原样采用；null / 空串 / 非法值（手改 localStorage、
 * 旧版本遗留值）一律容错为「跟随系统」，不抛异常。
 *
 * 宽松匹配沿用 matchSupported（"zh_cn" → "zh-CN"），与 resolveUiLanguage 对已保存值的
 * 处理保持一致——同一个存储值不该在"读设置"与"定语言"两处得出不同结论。
 */
export function resolveLanguageSetting(saved: string | null): LanguageSetting {
  if (saved === null) {
    return DEFAULT_LANGUAGE_SETTING;
  }
  const normalized = saved.trim().toLowerCase();
  if (isUiLanguageSetting(normalized)) {
    return normalized;
  }
  return matchSupported(saved) ?? DEFAULT_LANGUAGE_SETTING;
}

/**
 * 按优先级解析初始 UI 语言：
 * 1. saved —— 用户已保存的选择（"system"、非法值、未保存均视同未选，落到下一级）
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
