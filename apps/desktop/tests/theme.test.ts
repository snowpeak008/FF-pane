import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_PREFERENCE,
  FALLBACK_THEME,
  isThemePreference,
  resolveTheme,
  resolveThemeFromSaved,
  resolveThemePreference,
  THEME_PREFERENCES,
} from "../src/renderer/src/theme/resolve";

describe("主题偏好解析（保存值 → 默认 system）", () => {
  it("已保存的合法三态原样采用", () => {
    expect(resolveThemePreference("light")).toBe("light");
    expect(resolveThemePreference("dark")).toBe("dark");
    expect(resolveThemePreference("system")).toBe("system");
  });

  it("未保存过（null）时默认跟随系统", () => {
    expect(resolveThemePreference(null)).toBe("system");
    expect(DEFAULT_THEME_PREFERENCE).toBe("system");
  });

  it("非法值容错为默认偏好，不抛异常（防手改 localStorage 与旧版本遗留值）", () => {
    expect(resolveThemePreference("")).toBe("system");
    expect(resolveThemePreference("   ")).toBe("system");
    expect(resolveThemePreference("garbage")).toBe("system");
    expect(resolveThemePreference("auto")).toBe("system");
    expect(resolveThemePreference("true")).toBe("system");
  });

  it("大小写与首尾空白宽松匹配", () => {
    expect(resolveThemePreference("DARK")).toBe("dark");
    expect(resolveThemePreference(" Light ")).toBe("light");
    expect(resolveThemePreference("System")).toBe("system");
  });

  it("isThemePreference 与三态清单一致", () => {
    for (const preference of THEME_PREFERENCES) {
      expect(isThemePreference(preference)).toBe(true);
    }
    expect(isThemePreference("auto")).toBe(false);
    expect(isThemePreference("Dark")).toBe(false);
  });
});

describe("实际主题解析（手动覆盖 → 系统信号 → light 兜底）", () => {
  it("light / dark 为手动覆盖，忽略系统信号", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
  });

  it("system 偏好下跟随系统信号", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("system 偏好下拿不到系统信号时回退 light", () => {
    expect(resolveTheme("system", undefined)).toBe("light");
    expect(FALLBACK_THEME).toBe("light");
  });

  it("手动覆盖优先于「拿不到系统信号」", () => {
    expect(resolveTheme("dark", undefined)).toBe("dark");
    expect(resolveTheme("light", undefined)).toBe("light");
  });
});

describe("resolveThemeFromSaved：三级解析一步到位（首帧上色用）", () => {
  it("保存值优先", () => {
    expect(resolveThemeFromSaved("dark", false)).toBe("dark");
    expect(resolveThemeFromSaved("light", true)).toBe("light");
  });

  it("未保存或非法值时降级到系统信号", () => {
    expect(resolveThemeFromSaved(null, true)).toBe("dark");
    expect(resolveThemeFromSaved(null, false)).toBe("light");
    expect(resolveThemeFromSaved("garbage", true)).toBe("dark");
    expect(resolveThemeFromSaved("system", true)).toBe("dark");
  });

  it("两级都缺时回退 light", () => {
    expect(resolveThemeFromSaved(null, undefined)).toBe("light");
    expect(resolveThemeFromSaved("nonsense", undefined)).toBe("light");
  });
});
