/**
 * Codex 首轮手动发送的界面说明（T10.15）。
 * 按钮仍会写入；文案必须说清「会写回车」以及「确认框还在时不要点」。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function hint(tag: "zh-CN" | "en-US"): string {
  const pack = JSON.parse(
    readFileSync(new URL(`../../../locales/${tag}.json`, import.meta.url), "utf8"),
  ) as { workbench: { deliver: { codexManualHint: string } } };
  return pack.workbench.deliver.codexManualHint;
}

describe("Codex 手动发送提示", () => {
  it("中文写明会写入回车，确认框还在时不要点", () => {
    const text = hint("zh-CN");
    expect(text).toContain("回车");
    expect(text).toContain("不要点这个按钮");
    expect(text).toContain("权限信号");
  });

  it("英文写明会写入 Enter，确认框还在时不要点", () => {
    const text = hint("en-US");
    expect(text).toContain("one Enter");
    expect(text).toContain("do not press this button");
    expect(text).toContain("permission signal");
  });
});
