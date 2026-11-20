/**
 * T11.20：可改可跑命令的 Claude 窗口上项目内沙盒；全放开不靠用户设置跳过启动确认。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createWindowTokenRegistry } from "@ff-pane/core";
import { DEFAULT_SANDBOX_NETWORK_DOMAINS, type WorkbenchPermissionLevel } from "@ff-pane/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PtyManager } from "../src/main/terminal/manager";
import {
  CLAUDE_SANDBOX_GATE_ENV,
  CLAUDE_SANDBOX_MIN_VERSION,
  claudeSandboxSettings,
  compareVersions,
  detectSandboxStartupFailure,
  judgeClaudeSandbox,
  parseClaudeVersion,
  usesClaudeSandbox,
} from "../src/main/workbench/claude-sandbox";
import { buildInteractiveClaudeArgs } from "../src/main/workbench/cli-args";
import { releaseWindowHooks } from "../src/main/workbench/hook-launch";
import {
  type LaunchCliWindowDeps,
  launchCliWindow,
  WorkbenchCliLaunchError,
} from "../src/main/workbench/launch-cli";
import { WorkbenchMcpTempRegistry } from "../src/main/workbench/mcp-temp";
import type { LaunchCliRoute } from "../src/main/workbench/resolve-config";

describe("claude-sandbox 纯函数", () => {
  it("只有 Windows 上 edit-exec 的 Claude 上沙盒", () => {
    expect(
      usesClaudeSandbox({ runtime: "claude-code", permission: "edit-exec", platform: "win32" }),
    ).toBe(true);
    expect(
      usesClaudeSandbox({ runtime: "claude-code", permission: "edit-exec", platform: "darwin" }),
    ).toBe(false);
    for (const permission of ["read-only", "edit", "yolo"] as const) {
      expect(usesClaudeSandbox({ runtime: "claude-code", permission, platform: "win32" })).toBe(
        false,
      );
    }
    expect(
      usesClaudeSandbox({ runtime: "codex", permission: "edit-exec", platform: "win32" }),
    ).toBe(false);
  });

  it("sandbox 一段：起不来就退出、不许绕出去、sandboxuser 后端、项目外可写目录、默认名单加项目的", () => {
    const settings = claudeSandboxSettings({
      outsideDirs: ["D:\\share"],
      extraDomains: ["unity3d.com"],
    });
    expect(settings).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      windows: { backend: "sandboxuser" },
      filesystem: { allowWrite: ["D:\\share"] },
      network: { strictAllowlist: true },
    });
    expect((settings["network"] as { allowedDomains: string[] }).allowedDomains).toEqual([
      ...DEFAULT_SANDBOX_NETWORK_DOMAINS,
      "unity3d.com",
    ]);
  });

  it("版本号：认得出、比得对", () => {
    expect(parseClaudeVersion("2.1.329 (Claude Code)\n")).toBe("2.1.329");
    expect(parseClaudeVersion("no version")).toBeUndefined();
    expect(compareVersions("2.1.302", CLAUDE_SANDBOX_MIN_VERSION)).toBeLessThan(0);
    expect(compareVersions("2.1.329", CLAUDE_SANDBOX_MIN_VERSION)).toBe(0);
    expect(compareVersions("2.2.0", CLAUDE_SANDBOX_MIN_VERSION)).toBeGreaterThan(0);
    expect(compareVersions("10.0.0", "9.9.9")).toBeGreaterThan(0);
  });

  it("开窗前检查：版本旧、没装都拦，说清怎么办；版本认不出不拦", () => {
    const old = judgeClaudeSandbox({ version: "2.1.302", installed: true });
    expect(old.ok).toBe(false);
    expect(!old.ok && old.reason).toBe("version");
    expect(!old.ok && old.message).toContain("npm i -g @anthropic-ai/claude-code@latest");
    const missing = judgeClaudeSandbox({ version: "2.1.329", installed: false });
    expect(!missing.ok && missing.reason).toBe("not-installed");
    expect(!missing.ok && missing.message).toContain("claude sandbox install");
    expect(judgeClaudeSandbox({ version: undefined, installed: true }).ok).toBe(true);
  });

  it("认出终端里「沙盒起不来」那句（带颜色码也认）", () => {
    const out =
      "\x1b[31mError: sandbox required but unavailable: sandbox is enabled but the Windows sandbox is not active on this session (feature gate off)\x1b[0m\r\n  sandbox.failIfUnavailable is set";
    expect(detectSandboxStartupFailure(out)).toBe(
      "sandbox is enabled but the Windows sandbox is not active on this session (feature gate off)",
    );
    expect(detectSandboxStartupFailure("Welcome to Claude Code")).toBeUndefined();
  });
});

describe("buildInteractiveClaudeArgs 沙盒命令工具", () => {
  it("有 MCP 时和协作工具合成同一个 --allowedTools", () => {
    const args = buildInteractiveClaudeArgs({
      permission: "edit-exec",
      mcpConfigPath: "C:\\tmp\\mcp.json",
      allowedTools: ["mcp__ffpane-workbench"],
      sandboxCommandTools: ["PowerShell", "Bash"],
      initialPrompt: "开工",
    });
    expect(args.filter((arg) => arg.startsWith("--allowedTools"))).toHaveLength(1);
    const at = args.indexOf("--allowedTools");
    expect(args.slice(at, at + 5)).toEqual([
      "--allowedTools",
      "mcp__ffpane-workbench",
      "PowerShell",
      "Bash",
      "--mcp-config",
    ]);
    expect(args.at(-1)).toBe("开工");
  });

  it("没有 MCP 时用一个值的写法，开场白不会被吞成工具名", () => {
    const args = buildInteractiveClaudeArgs({
      permission: "edit-exec",
      sandboxCommandTools: ["PowerShell", "Bash"],
      initialPrompt: "开工",
    });
    expect(args).toContain("--allowedTools=PowerShell,Bash");
    expect(args.at(-1)).toBe("开工");
  });
});

const fakeBin = mkdtempSync(join(tmpdir(), "ffpane-claude-sandbox-"));
let restorePath: () => void = () => undefined;

beforeAll(() => {
  const bin = join(fakeBin, "node_modules", "claude", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude.js"), "process.exit(0)\n", "utf8");
  writeFileSync(
    join(fakeBin, "claude.cmd"),
    [
      "@ECHO off",
      "SETLOCAL",
      "CALL :find_dp0",
      `IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" ) ELSE ( SET "_prog=node" )`,
      `endLocal & "%_prog%"  "%dp0%\\node_modules\\claude\\bin\\claude.js" %*`,
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      "",
    ].join("\r\n"),
    "utf8",
  );
  writeFileSync(join(fakeBin, "workbench-hook.mjs"), "process.exit(0)\n", "utf8");
  const key = Object.keys(process.env).find((item) => item.toUpperCase() === "PATH") ?? "PATH";
  const previous = process.env[key];
  process.env[key] = previous === undefined ? fakeBin : `${fakeBin}${delimiter}${previous}`;
  restorePath = () => {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  };
});

afterAll(() => {
  restorePath();
  rmSync(fakeBin, { recursive: true, force: true });
});

const route: LaunchCliRoute = {
  connectionMode: "local_cli",
  configId: "cfg" as LaunchCliRoute["configId"],
  configName: "默认配置",
};

function harness(overrides: Partial<LaunchCliWindowDeps> = {}) {
  const captured: { env: Record<string, string>; args: readonly string[] }[] = [];
  const manager = {
    aliveCount: () => 0,
    create: (input: { env: Record<string, string>; direct: { args: readonly string[] } }) => {
      captured.push({ env: { ...input.env }, args: [...input.direct.args] });
      return { id: `term-${captured.length}` };
    },
  } as unknown as PtyManager;
  const deps: LaunchCliWindowDeps = {
    manager,
    getProvider: async () => undefined,
    revealSecret: async () => undefined,
    getMaxWorkbenchWindows: async () => 8,
    isKnowledgeToolEnabled: async () => false,
    getKnowledgeToolSettings: async () => undefined,
    indexDbFile: join(fakeBin, "index.db"),
    moduleDir: fakeBin,
    mcpRegistry: new WorkbenchMcpTempRegistry(),
    clampMax: (value: unknown) => (typeof value === "number" ? value : 8),
    limitErrorPrefix: "limit",
    tokenRegistry: createWindowTokenRegistry(),
    hookScriptPath: join(fakeBin, "workbench-hook.mjs"),
    outsideWriteDirs: async () => ["D:\\share"],
    sandboxNetworkDomains: async () => ["unity3d.com"],
    ...overrides,
  };
  return { captured, deps };
}

async function launch(
  deps: LaunchCliWindowDeps,
  windowId: string,
  permission: WorkbenchPermissionLevel,
): Promise<void> {
  await launchCliWindow(
    {
      windowId,
      projectId: "proj-sbx" as never,
      projectRoot: fakeBin,
      kind: "claude",
      route,
      cols: 80,
      rows: 24,
      permission,
      role: "worker",
    },
    deps,
  );
}

/** `--allowedTools` 放行的工具（多值写法或一个值的写法都认）。 */
function allowedToolsOf(args: readonly string[]): readonly string[] {
  const single = args.find((arg) => arg.startsWith("--allowedTools="));
  if (single !== undefined) {
    return single.slice("--allowedTools=".length).split(",");
  }
  const at = args.indexOf("--allowedTools");
  if (at < 0) {
    return [];
  }
  const out: string[] = [];
  for (const arg of args.slice(at + 1)) {
    if (arg.startsWith("--")) {
      break;
    }
    out.push(arg);
  }
  return out;
}

function settingsOf(args: readonly string[]): Record<string, unknown> {
  const at = args.indexOf("--settings");
  expect(at).toBeGreaterThanOrEqual(0);
  return JSON.parse(readFileSync(args[at + 1] ?? "", "utf8")) as Record<string, unknown>;
}

describe.runIf(process.platform === "win32")("launchCliWindow 项目内沙盒（T11.20）", () => {
  it("edit-exec：开内部开关、命令工具放行、settings 带 sandbox 段；查的是解析好的 claude", async () => {
    const checked: string[] = [];
    const { captured, deps } = harness({
      checkClaudeSandbox: async (target) => {
        checked.push(target.file);
        return { ok: true };
      },
    });
    try {
      await launch(deps, "win-sbx-1", "edit-exec");
      const first = captured[0];
      expect(first?.env[CLAUDE_SANDBOX_GATE_ENV]).toBe("1");
      expect(checked).toHaveLength(1);
      expect(first?.args.filter((arg) => arg.startsWith("--allowedTools"))).toHaveLength(1);
      expect(allowedToolsOf(first?.args ?? [])).toEqual(
        expect.arrayContaining(["mcp__ffpane-workbench", "PowerShell", "Bash"]),
      );
      const settings = settingsOf(first?.args ?? []);
      expect(settings["sandbox"]).toMatchObject({
        enabled: true,
        failIfUnavailable: true,
        windows: { backend: "sandboxuser" },
        filesystem: { allowWrite: ["D:\\share"] },
      });
      const domains = (settings["sandbox"] as { network: { allowedDomains: string[] } }).network
        .allowedDomains;
      expect(domains).toContain("unity3d.com");
      expect(domains).toContain("pypi.org");
      expect(settings["skipDangerousModePermissionPrompt"]).toBeUndefined();
    } finally {
      releaseWindowHooks("win-sbx-1");
    }
  });

  it("沙盒开不了：不开窗口，报 sandbox-unavailable 和办法", async () => {
    const { captured, deps } = harness({
      checkClaudeSandbox: async () => judgeClaudeSandbox({ version: "2.1.302", installed: true }),
    });
    const thrown = await launch(deps, "win-sbx-2", "edit-exec").catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(WorkbenchCliLaunchError);
    expect((thrown as WorkbenchCliLaunchError).code).toBe("sandbox-unavailable");
    expect((thrown as Error).message).toContain("2.1.329");
    expect(captured).toHaveLength(0);
  });

  it("全放开：settings 带跳过启动确认，没有 sandbox 段、没有内部开关", async () => {
    const { captured, deps } = harness({ checkClaudeSandbox: async () => ({ ok: true }) });
    try {
      await launch(deps, "win-sbx-3", "yolo");
      const first = captured[0];
      expect(first?.env[CLAUDE_SANDBOX_GATE_ENV]).toBeUndefined();
      expect(first?.args).toContain("--dangerously-skip-permissions");
      const settings = settingsOf(first?.args ?? []);
      expect(settings["skipDangerousModePermissionPrompt"]).toBe(true);
      expect(settings["sandbox"]).toBeUndefined();
    } finally {
      releaseWindowHooks("win-sbx-3");
    }
  });

  it("可改文件档：都不加", async () => {
    const { captured, deps } = harness({
      checkClaudeSandbox: async () => {
        throw new Error("不该查");
      },
    });
    try {
      await launch(deps, "win-sbx-4", "edit");
      const first = captured[0];
      expect(first?.env[CLAUDE_SANDBOX_GATE_ENV]).toBeUndefined();
      expect(allowedToolsOf(first?.args ?? [])).not.toContain("PowerShell");
      expect(allowedToolsOf(first?.args ?? [])).not.toContain("Bash");
      const settings = settingsOf(first?.args ?? []);
      expect(settings["sandbox"]).toBeUndefined();
      expect(settings["skipDangerousModePermissionPrompt"]).toBeUndefined();
    } finally {
      releaseWindowHooks("win-sbx-4");
    }
  });
});
