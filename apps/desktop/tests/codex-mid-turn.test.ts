/**
 * T11.7：Codex 干活中途收消息。命令串必须是 `& "node" "脚本"` 这种带 `& ` 的写法——
 * 2026-11-28 实测：同一次运行里带 `& ` 的跑了、直接写引号路径的没跑（PowerShell 不认裸引号路径）。
 * 这里只断言结构，不比对反斜杠转义层数（那是 TOML 的事，已用真实 Codex 验证过一遍）。
 */

import { describe, expect, it } from "vitest";
import { codexMidTurnHookConfig } from "../src/main/workbench/hook-launch";

describe("codexMidTurnHookConfig", () => {
  it("产出一条 PostToolUse 命令型 hook，命令以 & 开头、事件名对", () => {
    const config = codexMidTurnHookConfig("C:\\node.exe", "C:\\hook.mjs");
    const text = config["hooks.PostToolUse"] ?? "";
    expect(text.startsWith('[{hooks=[{type="command",command="& ')).toBe(true);
    expect(text.endsWith(",timeout=10}]}]")).toBe(true);
    // 事件名只出现一次，说明整条命令是一个字符串
    expect(text.split("CodexPostToolUse")).toHaveLength(2);
  });

  it("路径带空格也还是一条命令", () => {
    const config = codexMidTurnHookConfig("C:\\Program Files\\node.exe", "C:\\a b\\hook.mjs");
    const text = config["hooks.PostToolUse"] ?? "";
    expect(text.startsWith('[{hooks=[{type="command",command="& ')).toBe(true);
    expect(text.split("CodexPostToolUse")).toHaveLength(2);
    expect(text).not.toContain("},{");
  });
});
