/**
 * read_output 屏幕模式：重放后取渲染文字，加载动画只留最后一帧。
 */

import { describe, expect, it } from "vitest";
import {
  clampReadScreenLines,
  READ_SCREEN_DEFAULT_LINES,
  READ_SCREEN_MAX_LINES,
  renderTerminalText,
} from "../src/main/workbench/output-text";

describe("屏幕模式", () => {
  it("回车重画、清行和光标移动按终端语义落定", async () => {
    const frames = ["✢ Puttering…", "✶ Puttering…", "✻ Puttering…"]
      .map((frame) => `\r\u001b[2K${frame}`)
      .join("");
    const raw = `$ npm test\r\n${frames}\r\u001b[2K测试 12 项通过\r\n\u001b[1;1H#`;
    const text = await renderTerminalText(raw, { cols: 40, rows: 6 }, 60);
    expect(text).toBe("# npm test\n测试 12 项通过");
    expect(text).not.toContain("Puttering");
  });

  it("去掉只剩动画字符的行，空行收成一行，只留最后几行", async () => {
    const raw = ["一", "", "", "✻", "二", "⠋⠙⠹", "三"].join("\r\n");
    expect(await renderTerminalText(raw, { cols: 20, rows: 10 }, 60)).toBe("一\n\n二\n三");
    expect(await renderTerminalText(raw, { cols: 20, rows: 10 }, 2)).toBe("二\n三");
  });

  it("行数夹紧", () => {
    expect(clampReadScreenLines(undefined)).toBe(READ_SCREEN_DEFAULT_LINES);
    expect(clampReadScreenLines(0)).toBe(READ_SCREEN_DEFAULT_LINES);
    expect(clampReadScreenLines(10_000)).toBe(READ_SCREEN_MAX_LINES);
    expect(clampReadScreenLines(12.7)).toBe(12);
  });
});
