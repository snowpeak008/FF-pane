import { FALLBACK_UI_LANGUAGE, UI_LANGUAGES } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  FALLBACK_LANGUAGE,
  isSupportedLanguage,
  resolveUiLanguage,
  SUPPORTED_LANGUAGES,
} from "../src/renderer/src/i18n/resolve";

describe("UI 语言解析顺序（保存值 → 系统语言 → zh-CN 回退）", () => {
  it("已保存的合法选择优先于系统语言", () => {
    expect(resolveUiLanguage("zh-CN", "en-US")).toBe("zh-CN");
    expect(resolveUiLanguage("en-US", "zh-CN")).toBe("en-US");
  });

  it("保存值非法或为空时降级到系统语言", () => {
    expect(resolveUiLanguage("fr-FR", "zh-CN")).toBe("zh-CN");
    expect(resolveUiLanguage("garbage", "en-US")).toBe("en-US");
    expect(resolveUiLanguage(null, "zh-CN")).toBe("zh-CN");
    expect(resolveUiLanguage("", "zh-CN")).toBe("zh-CN");
  });

  it("系统语言宽松匹配：主语言子标签、大小写、下划线分隔", () => {
    expect(resolveUiLanguage(null, "zh")).toBe("zh-CN");
    expect(resolveUiLanguage(null, "zh-TW")).toBe("zh-CN");
    expect(resolveUiLanguage(null, "zh-Hans-CN")).toBe("zh-CN");
    expect(resolveUiLanguage(null, "ZH-CN")).toBe("zh-CN");
    expect(resolveUiLanguage(null, "zh_CN")).toBe("zh-CN");
    expect(resolveUiLanguage(null, "en-GB")).toBe("en-US");
  });

  it("保存值同样支持宽松匹配（防手改 localStorage 的非规范值）", () => {
    expect(resolveUiLanguage("zh_cn", "en-US")).toBe("zh-CN");
  });

  it("均无匹配时回退 FALLBACK_LANGUAGE", () => {
    expect(resolveUiLanguage(null, "ja-JP")).toBe(FALLBACK_LANGUAGE);
    expect(resolveUiLanguage("de-DE", "ko-KR")).toBe(FALLBACK_LANGUAGE);
    expect(resolveUiLanguage(null, "")).toBe(FALLBACK_LANGUAGE);
    expect(resolveUiLanguage(null, "   ")).toBe(FALLBACK_LANGUAGE);
  });

  it("解析回退是 zh-CN（2026-09-01 用户确认：中文为默认语言）", () => {
    expect(FALLBACK_LANGUAGE).toBe("zh-CN");
    // 系统语言不在支持清单内（且用户没选过）时落中文，而非英文
    expect(resolveUiLanguage(null, "ja-JP")).toBe("zh-CN");
    expect(resolveUiLanguage(null, "fr-FR")).toBe("zh-CN");
    // 系统语言检测保留：能匹配上就仍按系统语言走，回退只是最后一环
    expect(resolveUiLanguage(null, "en-GB")).toBe("en-US");
  });

  it("isSupportedLanguage 与支持清单一致", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(isSupportedLanguage(lang)).toBe(true);
    }
    expect(isSupportedLanguage("ja-JP")).toBe(false);
    expect(isSupportedLanguage("zh")).toBe(false);
  });

  it("注册表唯一：渲染层清单与回退语言即领域层同名常量（无第二份可漂移的清单）", () => {
    expect(SUPPORTED_LANGUAGES).toBe(UI_LANGUAGES);
    expect(FALLBACK_LANGUAGE).toBe(FALLBACK_UI_LANGUAGE);
  });
});
