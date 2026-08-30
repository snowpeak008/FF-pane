import { type ReactElement, type ReactNode, useEffect, useMemo, useState } from "react";
import { ThemeContext, type ThemeContextValue } from "./context";
import {
  applyResolvedTheme,
  persistThemePreference,
  readSavedThemePreference,
  subscribeSystemTheme,
  systemPrefersDark,
} from "./dom";
import { resolveTheme, resolveThemePreference, type ThemePreference } from "./resolve";

/**
 * 主题上下文提供者（W3.1a）：三态偏好（light / dark / system）+ 跟随系统 +
 * localStorage 持久化。整个 renderer 只允许一个实例，挂在 React 树最外层。
 */
export function ThemeProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    resolveThemePreference(readSavedThemePreference()),
  );
  const [prefersDark, setPrefersDark] = useState<boolean | undefined>(() => systemPrefersDark());

  // system 偏好下，操作系统改主题要即时反映；light / dark 手动覆盖时该信号被忽略
  useEffect(() => subscribeSystemTheme(setPrefersDark), []);

  const resolvedTheme = resolveTheme(preference, prefersDark);

  useEffect(() => {
    applyResolvedTheme(resolvedTheme);
  }, [resolvedTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolvedTheme,
      setPreference: (next: ThemePreference) => {
        persistThemePreference(next);
        setPreferenceState(next);
      },
    }),
    [preference, resolvedTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
