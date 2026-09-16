/**
 * matchesVerifyCommand：认出 Windows Codex 的 powershell 包装与 cd && 前缀，
 * 不认子串充数。
 */

import { describe, expect, it } from "vitest";
import { matchesVerifyCommand } from "../src/index.js";

const PS =
  '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "git status"';

describe("matchesVerifyCommand", () => {
  it("空白折叠后整串相等", () => {
    expect(matchesVerifyCommand("  git   status  ", "git status")).toBe(true);
  });

  it("Windows powershell -Command 包装（Codex 原文形态）", () => {
    expect(matchesVerifyCommand(PS, "git status")).toBe(true);
  });

  it("bash -lc / cmd /c 包装", () => {
    expect(matchesVerifyCommand("bash -lc 'npm test'", "npm test")).toBe(true);
    expect(matchesVerifyCommand("cmd /c npm test", "npm test")).toBe(true);
  });

  it("cd 到项目根再跑", () => {
    expect(matchesVerifyCommand("cd /proj && git status", "git status")).toBe(true);
    expect(matchesVerifyCommand("cd C:\\\\work; git status", "git status")).toBe(true);
  });

  it("包装 + 复合命令：载荷末段是验证命令", () => {
    expect(
      matchesVerifyCommand(
        'powershell.exe -NoProfile -Command "cd C:\\\\proj; git status"',
        "git status",
      ),
    ).toBe(true);
  });

  it("不认子串充数", () => {
    expect(matchesVerifyCommand("echo git status", "git status")).toBe(false);
    expect(matchesVerifyCommand("git status --porcelain", "git status")).toBe(false);
  });

  it("不把 git -c 当成 shell 包装", () => {
    expect(matchesVerifyCommand("git -c core.foo=1 status", "status")).toBe(false);
    expect(matchesVerifyCommand("git -c core.foo=1 status", "git -c core.foo=1 status")).toBe(true);
  });

  it("空期望不匹配", () => {
    expect(matchesVerifyCommand("git status", "   ")).toBe(false);
  });
});
