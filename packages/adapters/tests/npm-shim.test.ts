/**
 * npm .cmd 垫片解析 → 直接 spawn 目标（绕开 cmd.exe）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseNpmCmdShim,
  resolveDirectCliTarget,
  resolveHookNodeExecutable,
} from "../src/process/npm-shim.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ffpane-shim-"));
  temps.push(dir);
  return dir;
}

describe("parseNpmCmdShim", () => {
  it("解析 claude 形态：dp0 相对 .exe", () => {
    const dir = tempDir();
    const bin = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin");
    mkdirSync(bin, { recursive: true });
    const exe = join(bin, "claude.exe");
    writeFileSync(exe, "MZ");
    const cmd = join(dir, "claude.cmd");
    writeFileSync(
      cmd,
      [
        "@ECHO off",
        "SETLOCAL",
        "CALL :find_dp0",
        '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        "",
      ].join("\r\n"),
    );
    const parsed = parseNpmCmdShim(cmd);
    expect(parsed?.kind).toBe("shim-exe");
    expect(parsed?.file.toLowerCase()).toBe(exe.toLowerCase());
    expect(parsed?.prefixArgs).toEqual([]);
  });

  it("解析 codex 形态：node + .js", () => {
    const dir = tempDir();
    const scriptDir = join(dir, "node_modules", "@openai", "codex", "bin");
    mkdirSync(scriptDir, { recursive: true });
    const script = join(scriptDir, "codex.js");
    writeFileSync(script, "console.log('ok')");
    const nodeExe = join(dir, "node.exe");
    writeFileSync(nodeExe, "MZ");
    const cmd = join(dir, "codex.cmd");
    writeFileSync(
      cmd,
      [
        "@ECHO off",
        "SETLOCAL",
        "CALL :find_dp0",
        'IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" ) ELSE ( SET "_prog=node" )',
        'endLocal & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        "",
      ].join("\r\n"),
    );
    const parsed = parseNpmCmdShim(cmd);
    expect(parsed?.kind).toBe("shim-node");
    expect(parsed?.file.toLowerCase()).toBe(nodeExe.toLowerCase());
    expect(parsed?.prefixArgs[0]?.toLowerCase()).toBe(script.toLowerCase());
  });
});

describe("resolveDirectCliTarget", () => {
  it("PATH 上的 .cmd 垫片解析为直启，多行 args 原样保留", () => {
    if (process.platform !== "win32") {
      return;
    }
    const dir = tempDir();
    const bin = join(dir, "node_modules", "x", "bin");
    mkdirSync(bin, { recursive: true });
    const exe = join(bin, "tool.exe");
    writeFileSync(exe, "MZ");
    const cmd = join(dir, "tool.cmd");
    writeFileSync(cmd, `@ECHO off\r\n"%dp0%\\node_modules\\x\\bin\\tool.exe" %*\r\n`);
    const prompt = "line1\nline2 & echo PWNED\n%PATH%";
    const target = resolveDirectCliTarget("tool", ["--flag", prompt], {
      ...process.env,
      Path: `${dir};${process.env["Path"] ?? ""}`,
      PATH: `${dir};${process.env["PATH"] ?? ""}`,
    });
    expect(target).toBeDefined();
    expect(target?.kind).toBe("shim-exe");
    expect(target?.args).toEqual(["--flag", prompt]);
    expect(target?.file.toLowerCase()).toBe(exe.toLowerCase());
  });

  it("无法解析的 .cmd 返回 undefined（拒绝 cmd 回退）", () => {
    if (process.platform !== "win32") {
      return;
    }
    const dir = tempDir();
    const cmd = join(dir, "weird.cmd");
    writeFileSync(cmd, "@ECHO off\r\necho hi\r\n");
    const target = resolveDirectCliTarget("weird", [], {
      ...process.env,
      Path: `${dir};${process.env["Path"] ?? ""}`,
      PATH: `${dir};${process.env["PATH"] ?? ""}`,
    });
    expect(target).toBeUndefined();
  });
});

describe("resolveHookNodeExecutable", () => {
  it("shim-node 复用已经确定的 node.exe", () => {
    const dir = tempDir();
    const nodeExe = join(dir, "node.exe");
    writeFileSync(nodeExe, "MZ");
    expect(
      resolveHookNodeExecutable({ PATH: "", Path: "" }, { kind: "shim-node", file: nodeExe }),
    ).toBe(nodeExe);
  });

  it("原生 exe 且 PATH 上没有 node.exe 时不退回 cmd", () => {
    const dir = tempDir();
    const exe = join(dir, "codex.exe");
    const cmd = join(dir, "node.cmd");
    writeFileSync(exe, "MZ");
    writeFileSync(cmd, "@echo off\r\n");
    expect(
      resolveHookNodeExecutable(
        { PATH: dir, Path: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        { kind: "native", file: exe },
      ),
    ).toBeUndefined();
  });
});
