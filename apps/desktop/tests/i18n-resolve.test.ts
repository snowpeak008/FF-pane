import { describe, expect, it } from "vitest";
import {
  FALLBACK_LANGUAGE,
  isSupportedLanguage,
  resolveUiLanguage,
  SUPPORTED_LANGUAGES,
} from "../src/renderer/src/i18n/resolve";

describe("UI 语言解析顺序（保存值 → 系统语言 → en-US 回退）", () => {
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

  it("均无匹配时回退 en-US", () => {
    expect(resolveUiLanguage(null, "ja-JP")).toBe(FALLBACK_LANGUAGE);
    expect(resolveUiLanguage("de-DE", "ko-KR")).toBe(FALLBACK_LANGUAGE);
    expect(resolveUiLanguage(null, "")).toBe(FALLBACK_LANGUAGE);
    expect(resolveUiLanguage(null, "   ")).toBe(FALLBACK_LANGUAGE);
  });

  it("isSupportedLanguage 与支持清单一致", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(isSupportedLanguage(lang)).toBe(true);
    }
    expect(isSupportedLanguage("ja-JP")).toBe(false);
    expect(isSupportedLanguage("zh")).toBe(false);
  });
});
