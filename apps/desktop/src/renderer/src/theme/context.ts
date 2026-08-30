import { createContext } from "react";
import type { ResolvedTheme, ThemePreference } from "./resolve";

export interface ThemeContextValue {
  /** 用户偏好三态（light / dark / system），设置界面直接绑定此值。 */
  readonly preference: ThemePreference;
  /** 当前实际生效的主题，供需要按明暗分支的少数逻辑（如 diff 高亮）读取。 */
  readonly resolvedTheme: ResolvedTheme;
  readonly setPreference: (preference: ThemePreference) => void;
}

/** null 表示未被 ThemeProvider 包裹；useTheme 会就此抛错，避免静默拿到假值。 */
export const ThemeContext = createContext<ThemeContextValue | null>(null);
