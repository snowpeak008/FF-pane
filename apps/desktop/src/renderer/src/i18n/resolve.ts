/**
 * UI 语言解析（纯逻辑，无浏览器/Electron 依赖，可直接单测）。
 * 解析顺序：用户已保存的选择 → 系统语言 → en-US 回退（项目设计计划 §9.1）。
 */

export const SUPPORTED_LANGUAGES = ["zh-CN", "en-US"] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const FALLBACK_LANGUAGE: SupportedLanguage = "en-US";

export function isSupportedLanguage(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * 按优先级解析初始 UI 语言：
 * 1. saved —— 用户已保存的选择（非法值视同未保存）
 * 2. systemLocale —— 主进程 app.getLocale() 的系统语言（支持宽松匹配，如 zh / zh-TW → zh-CN）
 * 3. FALLBACK_LANGUAGE（en-US）
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
