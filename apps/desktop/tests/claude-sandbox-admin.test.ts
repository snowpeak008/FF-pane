/**
 * T11.20 §3.4：设置里「Claude 沙盒」读 `claude sandbox …` 的输出。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

const { lastJsonLine, parseSandboxCommandResult } = await import(
  "../src/main/claude-sandbox-admin"
);

describe("claude sandbox 输出", () => {
  it("取最后一行 JSON，前面的提示文字不算", () => {
    const status = lastJsonLine(
      'Requesting elevation...\n{"statusVersion":3,"installed":true,"reasons":[]}\n',
    );
    expect(status?.["installed"]).toBe(true);
    expect(lastJsonLine("no json here")).toBeUndefined();
    expect(lastJsonLine('{"broken": \n')).toBeUndefined();
  });

  it("install / uninstall：status 为 ok 才算成，留下的东西逐条列出", () => {
    expect(parseSandboxCommandResult('{"status":"ok","message":"Installed."}', true)).toEqual({
      ok: true,
      message: "Installed.",
    });
    expect(
      parseSandboxCommandResult(
        '{"status":"ok","message":"Removed.","leftBehind":["C:\\\\Users\\\\srt-sandbox"]}',
        true,
      ),
    ).toEqual({ ok: true, message: "Removed.\n· C:\\Users\\srt-sandbox" });
    expect(
      parseSandboxCommandResult('{"status":"cancelled","message":"UAC was declined."}', false),
    ).toEqual({ ok: false, message: "UAC was declined." });
  });

  it("没有 JSON：失败，带上原输出", () => {
    expect(parseSandboxCommandResult("error: unknown command 'sandbox'", false)).toEqual({
      ok: false,
      message: "error: unknown command 'sandbox'",
    });
    expect(parseSandboxCommandResult("", false).ok).toBe(false);
  });
});
