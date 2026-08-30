/**
 * 主题解析（纯逻辑，无浏览器/Electron 依赖，可直接单测）。
 * 解析顺序沿用 i18n 先例（src/renderer/src/i18n/resolve.ts）：
 * 用户已保存的选择 → system（跟随系统 prefers-color-scheme）→ light 兜底。
 * 见 docs/设计系统.md §7、开发计划 §1.5 第 6 条。
 */

/** 用户可选的三态偏好；system 表示交给操作系统决定。 */
export const THEME_PREFERENCES = ["system", "light", "dark"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** 最终落到 DOM 上的实际主题（只有两种）。 */
export type ResolvedTheme = "light" | "dark";

/** 未保存过选择时的默认偏好：跟随系统。 */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system";

/** 系统偏好检测失败、或 system 偏好下拿不到系统信号时的兜底实际主题。 */
export const FALLBACK_THEME: ResolvedTheme = "light";

export function isThemePreference(value: string): value is ThemePreference {
  return (THEME_PREFERENCES as readonly string[]).includes(value);
}

/**
 * 解析持久化的偏好值：合法值原样采用，null / 空串 / 非法值（手改 localStorage、
 * 旧版本遗留值）一律容错为 DEFAULT_THEME_PREFERENCE，不抛异常。
 */
export function resolveThemePreference(saved: string | null): ThemePreference {
  if (saved === null) {
    return DEFAULT_THEME_PREFERENCE;
  }
  const normalized = saved.trim().toLowerCase();
  return isThemePreference(normalized) ? normalized : DEFAULT_THEME_PREFERENCE;
}

/**
 * 由偏好 + 系统信号得出实际主题：
 * light / dark 为手动覆盖，system 才读系统信号（拿不到时按 FALLBACK_THEME）。
 */
export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean | undefined,
): ResolvedTheme {
  if (preference === "light" || preference === "dark") {
    return preference;
  }
  if (systemPrefersDark === undefined) {
    return FALLBACK_THEME;
  }
  return systemPrefersDark ? "dark" : "light";
}

/** 一步到位：从持久化值 + 系统信号解析实际主题（启动时首帧用，避免主题闪白）。 */
export function resolveThemeFromSaved(
  saved: string | null,
  systemPrefersDark: boolean | undefined,
): ResolvedTheme {
  return resolveTheme(resolveThemePreference(saved), systemPrefersDark);
}
