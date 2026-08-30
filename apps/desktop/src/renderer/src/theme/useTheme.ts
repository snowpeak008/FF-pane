import { useContext } from "react";
import { ThemeContext, type ThemeContextValue } from "./context";

/** 读取当前主题与切换入口；必须在 ThemeProvider 内使用。 */
export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) {
    // 开发者日志/异常英文（check-i18n 扫描约定）
    throw new Error("useTheme must be used within <ThemeProvider>");
  }
  return value;
}
