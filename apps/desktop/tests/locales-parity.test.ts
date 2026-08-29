import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGES } from "../src/renderer/src/i18n/resolve";

/**
 * 语言包结构一致性：各语言包的 key 集合必须完全一致且叶子值非空，
 * 防止「缺失 key 静默回退 en-US」在日常开发中越积越多。
 */
function loadLocale(tag: string): Record<string, unknown> {
  const url = new URL(`../../../locales/${tag}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

function collectLeafPaths(node: Record<string, unknown>, prefix: string, out: string[]): void {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value === "object" && value !== null) {
      collectLeafPaths(value as Record<string, unknown>, path, out);
    } else {
      expect(typeof value, `叶子值必须是字符串：${path}`).toBe("string");
      expect((value as string).trim().length, `叶子值不得为空：${path}`).toBeGreaterThan(0);
      out.push(path);
    }
  }
}

describe("locales/*.json 语言包一致性", () => {
  const packs = SUPPORTED_LANGUAGES.map((tag) => {
    const paths: string[] = [];
    collectLeafPaths(loadLocale(tag), "", paths);
    return { tag, paths: paths.sort() };
  });

  it("每个支持语言都有语言包且非空", () => {
    for (const pack of packs) {
      expect(pack.paths.length, `语言包为空：${pack.tag}`).toBeGreaterThan(0);
    }
  });

  it("全部语言包的 key 集合完全一致", () => {
    const [base, ...rest] = packs;
    expect(base).toBeDefined();
    for (const pack of rest) {
      expect(pack.paths, `key 集合不一致：${pack.tag} vs ${base?.tag}`).toEqual(base?.paths);
    }
  });
});
