/** 主题模块对外出口：页面/组件只从这里导入，不直接引用内部文件。 */
export type { ThemeContextValue } from "./context";
export { applyThemeAtBoot } from "./dom";
export {
  DEFAULT_THEME_PREFERENCE,
  isThemePreference,
  type ResolvedTheme,
  THEME_PREFERENCES,
  type ThemePreference,
} from "./resolve";
export { ThemeProvider } from "./ThemeProvider";
export { useTheme } from "./useTheme";
