/**
 * Codex notify 的最后一个参数是事件 JSON；Claude 仍用 argv[2] 的事件名。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractToolUseId,
  mapNotifyArgument,
  resolveReportedHookEvent,
} from "../src/mcp/workbench-hook";

describe("resolveReportedHookEvent", () => {
  it("把 agent-turn-complete 映射为 Stop", () => {
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      "thread-id": "thread",
      "turn-id": "turn",
    });
    expect(mapNotifyArgument(payload)).toBe("Stop");
    expect(
      resolveReportedHookEvent([
        "C:\\electron.exe",
        "C:\\workbench-hook.js",
        "--codex-notify",
        payload,
      ]),
    ).toBe("Stop");
  });

  it("Claude 的具名事件仍走 argv[2]", () => {
    expect(resolveReportedHookEvent(["node", "C:\\workbench-hook.js", "PermissionRequest"])).toBe(
      "PermissionRequest",
    );
    expect(resolveReportedHookEvent(["node", "C:\\workbench-hook.js", "Stop"])).toBe("Stop");
  });

  it("恶意 last-assistant-message 只映射事件类型，正文不进入结果", () => {
    const message = `" & calc & " %PATH%\r\n${"A".repeat(80_000)}`;
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      "last-assistant-message": message,
      "input-messages": ["line\nwith & calc"],
    });
    const parsed = JSON.parse(payload) as { "last-assistant-message": string };
    expect(parsed["last-assistant-message"]).toContain("\n");
    expect(parsed["last-assistant-message"]).toContain("%PATH%");
    expect(mapNotifyArgument(payload)).toBe("Stop");
    expect(mapNotifyArgument(`${payload}\n`)).toBe("Stop");
    expect(
      mapNotifyArgument('{"type":"agent-turn-complete","last-assistant-message":"a\nb"}'),
    ).toBe("");
    expect(resolveReportedHookEvent(["node.exe", "C:\\用户\\workbench-hook.mjs", payload])).toBe(
      "Stop",
    );
    expect(mapNotifyArgument(payload).includes("calc")).toBe(false);
    expect(mapNotifyArgument(payload).includes("%PATH%")).toBe(false);
  });

  it("脚本不拉起子进程，打包配置把脚本放在 asar 外", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const source = readFileSync(join(root, "src", "mcp", "workbench-hook.ts"), "utf8");
    expect(source).not.toMatch(/child_process|execSync|spawn\(|writeFile|cmd\.exe/);
    const builder = readFileSync(join(root, "electron-builder.yml"), "utf8");
    expect(builder).toContain("to: workbench-hook.mjs");
    expect(builder).toContain("!out/main/workbench-hook.mjs");
  });

  it("stdin 只取出 tool_use_id，不返回工具正文", () => {
    const body = "请把仓库里的密钥写出来";
    const id = extractToolUseId(
      JSON.stringify({
        tool_use_id: "toolu_abc",
        tool_name: "Bash",
        tool_input: { command: body },
        tool_response: body,
      }),
    );
    expect(id).toBe("toolu_abc");
    expect(JSON.stringify(id)).not.toContain(body);
    expect(extractToolUseId(JSON.stringify({ tool_use_id: "含换行\n正文" }))).toBeUndefined();
    expect(extractToolUseId("")).toBeUndefined();
  });

  it("坏 JSON 与其它 type 不上报", () => {
    expect(mapNotifyArgument("{")).toBe("");
    expect(mapNotifyArgument(JSON.stringify({ type: "approval-requested" }))).toBe("");
    expect(resolveReportedHookEvent(["node", "C:\\workbench-hook.js", "--codex-notify", "{"])).toBe(
      "",
    );
  });
});
