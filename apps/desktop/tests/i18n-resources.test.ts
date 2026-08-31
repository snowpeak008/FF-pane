import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGES } from "../src/renderer/src/i18n/resolve";
import { LANGUAGE_OPTIONS, resources } from "../src/renderer/src/i18n/resources";

/**
 * 语言包注册表与界面语言选择器的选项。
 * 选项标签是各语言的「自称」（endonym）且不经 t()：新增语言只需登记注册表 + 语言包，
 * 不必再往每一本语言包补一条 settings.languageName.<tag>（漏改时无任何检查会红）。
 */
function readPack(tag: string): Record<string, unknown> {
  const url = new URL(`../../../locales/${tag}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

describe("i18n resources 注册表", () => {
  it("每种受支持语言都有语言包（缺失即编译失败，此处再钉运行期）", () => {
    for (const tag of SUPPORTED_LANGUAGES) {
      expect(Object.keys(resources)).toContain(tag);
    }
    expect(Object.keys(resources).length).toBe(SUPPORTED_LANGUAGES.length);
  });
});

describe("LANGUAGE_OPTIONS：界面语言选择器的选项", () => {
  it("覆盖全部受支持语言，顺序随注册表", () => {
    expect(LANGUAGE_OPTIONS.map((option) => option.code)).toEqual([...SUPPORTED_LANGUAGES]);
  });

  it("标签取自各语言包内的自称，不是当前界面语言下的译名", () => {
    // 每个 label 必须等于「该语言自己那本」语言包里的 displayName，而非任何其他语言包的说法
    for (const { code, label } of LANGUAGE_OPTIONS) {
      const own = readPack(code) as {
        settings: { language: { displayName: string } };
      };
      expect(label).toBe(own.settings.language.displayName);
    }
  });

  it("自称与界面语言无关：无论界面是中文还是英文，两项恒为 简体中文 / English", () => {
    expect(LANGUAGE_OPTIONS).toEqual([
      { code: "zh-CN", label: "简体中文" },
      { code: "en-US", label: "English" },
    ]);
  });

  it("标签非空且互不重复（同名选项无法区分）", () => {
    const labels = LANGUAGE_OPTIONS.map((option) => option.label);
    for (const label of labels) {
      expect(label.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(labels).size).toBe(labels.length);
  });
});
