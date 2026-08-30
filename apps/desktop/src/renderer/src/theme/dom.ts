/**
 * 主题的浏览器侧副作用：持久化读写、系统偏好探测、DOM 应用。
 * 纯逻辑部分在 ./resolve.ts（单测覆盖），本文件只做无分支的胶水。
 */
import { type ResolvedTheme, resolveThemeFromSaved, type ThemePreference } from "./resolve";

/**
 * 主题选择持久化：Phase 3 暂存 localStorage；与 i18n 语言选择同一先例
 * （src/renderer/src/i18n/index.ts），Phase 1 已落地的文件存储层接入界面后，
 * 迁移到全局 config.json（~/.aiworkbench/config.json，项目设计计划 §10.1）。
 * 迁移时本模块是唯一改动点：读写换成 IPC，resolve.ts 与 ThemeProvider 不动。
 */
const STORAGE_KEY = "ffpane.ui-theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** html 上的暗色标记类名，与 theme.css 的 `@custom-variant dark` 约定一致。 */
const DARK_CLASS = "dark";

export function readSavedThemePreference(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch (thrown) {
    // 开发者日志英文（check-i18n 扫描约定）；读不到就按默认偏好走
    console.error("[renderer] theme preference read failed:", thrown);
    return null;
  }
}

export function persistThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch (thrown) {
    console.error("[renderer] theme preference write failed:", thrown);
  }
}

/** 系统是否偏好暗色；matchMedia 不可用时返回 undefined 交给 resolveTheme 兜底。 */
export function systemPrefersDark(): boolean | undefined {
  if (typeof window.matchMedia !== "function") {
    return undefined;
  }
  return window.matchMedia(DARK_QUERY).matches;
}

/** 订阅系统明暗变化（system 偏好下即时生效），返回取消订阅函数。 */
export function subscribeSystemTheme(onChange: (prefersDark: boolean) => void): () => void {
  if (typeof window.matchMedia !== "function") {
    return () => {};
  }
  const query = window.matchMedia(DARK_QUERY);
  const handler = (event: MediaQueryListEvent): void => onChange(event.matches);
  query.addEventListener("change", handler);
  return () => query.removeEventListener("change", handler);
}

/**
 * 把实际主题落到 html 上：class 供 Tailwind 的 dark 变体与 `.dark` token 覆盖使用，
 * colorScheme 让原生控件（滚动条、select 弹出层、表单控件）同步跟随。
 */
export function applyResolvedTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle(DARK_CLASS, theme === "dark");
  root.style.colorScheme = theme;
}

/**
 * 挂载 React 之前同步应用一次主题。
 * main.tsx 需 await i18n 初始化（走 IPC）后才挂载 React，若等到 ThemeProvider 的
 * effect 才上色，用户会先看到一帧亮色。生产 CSP 禁内联脚本（src/main/csp.ts），
 * 无法在 index.html 里塞引导脚本，故由本函数在模块求值阶段同步完成。
 */
export function applyThemeAtBoot(): void {
  applyResolvedTheme(resolveThemeFromSaved(readSavedThemePreference(), systemPrefersDark()));
}
