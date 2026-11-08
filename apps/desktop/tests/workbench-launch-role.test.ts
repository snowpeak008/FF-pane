/**
 * T10.6'：启动 / 续接 / 重启后角色仍在；启动参数带 hooks 且不含令牌明文。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createWindowTokenRegistry } from "@ff-pane/core";
import type { ProjectWorkbenchLayout } from "@ff-pane/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PtyManager } from "../src/main/terminal/manager";
import { createWorkbenchAuthRegistry } from "../src/main/workbench/auth-registry";
import { releaseWindowHooks } from "../src/main/workbench/hook-launch";
import { launchCliWindow } from "../src/main/workbench/launch-cli";
import { WorkbenchMcpTempRegistry } from "../src/main/workbench/mcp-temp";
import type { LaunchCliRoute } from "../src/main/workbench/resolve-config";

const fakeBin = mkdtempSync(join(tmpdir(), "ffpane-launch-role-"));
let restorePath: () => void = () => undefined;

function writeShim(name: string): void {
  const bin = join(fakeBin, "node_modules", name, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, `${name}.js`);
  writeFileSync(script, "process.exit(0)\n", "utf8");
  writeFileSync(
    join(fakeBin, `${name}.cmd`),
    [
      "@ECHO off",
      "SETLOCAL",
      "CALL :find_dp0",
      `IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" ) ELSE ( SET "_prog=node" )`,
      `endLocal & "%_prog%"  "%dp0%\\node_modules\\${name}\\bin\\${name}.js" %*`,
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      "",
    ].join("\r\n"),
    "utf8",
  );
}

beforeAll(() => {
  writeShim("claude");
  writeShim("codex");
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

function localRoute(): LaunchCliRoute {
  return {
    connectionMode: "local_cli",
    configId: "cfg" as LaunchCliRoute["configId"],
    configName: "默认配置",
    model: "sonnet",
  };
}

function layout(windowId: string, role: string): ProjectWorkbenchLayout {
  return {
    projectId: "proj-role" as never,
    tabs: [{ id: "tab-1", title: "Tab", slots: [windowId, null, null, null, null, null] }],
    activeTabId: "tab-1",
    windows: {
      [windowId]: {
        id: windowId,
        projectId: "proj-role" as never,
        title: "W",
        kind: "claude",
        cwd: fakeBin,
        createdAt: 1,
        role: role as never,
        permission: "edit",
        openedBy: "user",
      },
    },
    maximizedWindowId: null,
    focusedWindowId: windowId,
  };
}

describe("launchCliWindow 角色与 hooks", () => {
  it("启动、续接、重启后角色保持，且 Claude settings / Codex hooks 不含令牌", async () => {
    const captured: { env: Record<string, string>; args: readonly string[] }[] = [];
    const manager = {
      aliveCount: () => 0,
      create: (input: { env: Record<string, string>; direct: { args: readonly string[] } }) => {
        captured.push({ env: { ...input.env }, args: [...input.direct.args] });
        return { id: `term-${captured.length}` };
      },
    } as unknown as PtyManager;
    const tokenRegistry = createWindowTokenRegistry();
    const authRegistry = createWorkbenchAuthRegistry();
    const windowId = "win-role";
    const deps = {
      manager,
      getProvider: async () => ({
        id: "prov",
        name: "Local",
        templateId: "local-login",
        defaultModelId: "sonnet",
      }),
      revealSecret: async () => undefined,
      getMaxWorkbenchWindows: async () => 8,
      isKnowledgeToolEnabled: async () => false,
      getKnowledgeToolSettings: async () => undefined,
      indexDbFile: join(fakeBin, "index.db"),
      moduleDir: fakeBin,
      mcpRegistry: new WorkbenchMcpTempRegistry(),
      clampMax: (value: unknown) => (typeof value === "number" ? value : 8),
      limitErrorPrefix: "limit",
      tokenRegistry,
      authRegistry,
      controlPipe: "\\\\.\\pipe\\ff-pane-wb-test",
      hookScriptPath: join(fakeBin, "workbench-hook.mjs"),
    };
    writeFileSync(join(fakeBin, "workbench-hook.mjs"), "process.exit(0)\n", "utf8");

    try {
      await launchCliWindow(
        {
          windowId,
          projectId: "proj-role" as never,
          projectRoot: fakeBin,
          kind: "claude" as const,
          route: localRoute(),
          cols: 80,
          rows: 24,
          role: "worker",
        },
        deps,
      );
      expect(authRegistry.get(windowId)?.role).toBe("worker");
      const first = captured[0];
      expect(first).toBeDefined();
      const token = first?.env["FF_PANE_WINDOW_TOKEN"] ?? "";
      expect(token.length).toBeGreaterThanOrEqual(64);
      // T11.8：Claude 窗口带上能写的目录，第一个是项目目录。
      const roots = JSON.parse(first?.env["FF_PANE_WRITE_ROOTS"] ?? "[]") as string[];
      expect(roots[0]?.toLowerCase()).toBe(fakeBin.toLowerCase());
      expect(first?.env["FF_PANE_WB_PIPE"]).toBe("\\\\.\\pipe\\ff-pane-wb-test");
      expect(first?.env["ANTHROPIC_API_KEY"]).toBeUndefined();
      expect(first?.args.join("\n")).not.toContain(token);
      const settingsFlag = first?.args.indexOf("--settings") ?? -1;
      expect(settingsFlag).toBeGreaterThanOrEqual(0);
      const settingsPath = first?.args[settingsFlag + 1] ?? "";
      const settingsBody = readFileSync(settingsPath, "utf8");
      expect(settingsBody).toContain("PermissionRequest");
      expect(settingsBody).toContain("Stop");
      expect(settingsBody).toContain("UserPromptSubmit");
      expect(settingsBody).toContain("SessionStart");
      expect(settingsBody).not.toContain("disableAllHooks");
      expect(settingsBody).not.toContain(token);
      const parsed = JSON.parse(settingsBody) as {
        hooks: Record<string, { hooks: { command: string; args: string[] }[] }[]>;
      };
      const stopHook = parsed.hooks["Stop"]?.[0]?.hooks[0];
      expect(stopHook?.args[1]).toBe("Stop");
      expect(stopHook?.args[0]).toContain("workbench-hook.mjs");
      expect(stopHook?.command.toLowerCase()).toMatch(/node(?:\.exe)?$/);
      // 只看真的会被启动的 command / args；PreToolUse 的 matcher 里有工具名 PowerShell，不是启动命令。
      const launched = Object.values(parsed.hooks)
        .flatMap((groups) => groups.flatMap((group) => group.hooks))
        .flatMap((hook) => [hook.command, ...hook.args])
        .join("\n");
      expect(launched).not.toMatch(/\.cmd|cmd\.exe|powershell|ELECTRON_RUN_AS_NODE/i);
      expect(settingsBody).not.toMatch(/ELECTRON_RUN_AS_NODE/);
      // T11.8：写文件和命令工具前先做项目外写入检查，同一个 hook 脚本。
      const guard = (
        parsed.hooks["PreToolUse"] as unknown as
          | { matcher: string; hooks: { command: string; args: string[] }[] }[]
          | undefined
      )?.[0];
      expect(guard?.matcher).toContain("Write");
      expect(guard?.matcher).toContain("Bash");
      expect(guard?.hooks[0]?.args).toEqual([stopHook?.args[0], "PreToolUse"]);

      await launchCliWindow(
        {
          windowId,
          projectId: "proj-role" as never,
          projectRoot: fakeBin,
          kind: "claude" as const,
          route: localRoute(),
          cols: 80,
          rows: 24,
          role: "manager",
          resume: true,
          nativeSessionId: "11111111-1111-4111-8111-111111111111",
        },
        deps,
      );
      expect(authRegistry.get(windowId)?.role).toBe("worker");

      const stale = authRegistry.syncLayout(layout(windowId, "none"));
      expect(stale.windows[windowId]?.role).toBe("worker");
      const restarted = createWorkbenchAuthRegistry();
      restarted.syncLayout(stale);
      await launchCliWindow(
        {
          windowId,
          projectId: "proj-role" as never,
          projectRoot: fakeBin,
          kind: "claude" as const,
          route: localRoute(),
          cols: 80,
          rows: 24,
          resume: true,
          nativeSessionId: "11111111-1111-4111-8111-111111111111",
        },
        { ...deps, authRegistry: restarted, tokenRegistry: createWindowTokenRegistry() },
      );
      expect(restarted.get(windowId)?.role).toBe("worker");

      const codexRegistry = createWorkbenchAuthRegistry();
      const codexTokens = createWindowTokenRegistry();
      await launchCliWindow(
        {
          windowId: "win-codex",
          projectId: "proj-role" as never,
          projectRoot: fakeBin,
          kind: "codex" as const,
          route: localRoute(),
          cols: 80,
          rows: 24,
          role: "planner",
        },
        {
          ...deps,
          authRegistry: codexRegistry,
          tokenRegistry: codexTokens,
        },
      );
      expect(codexRegistry.get("win-codex")?.role).toBe("planner");
      const codex = captured.at(-1);
      const codexToken = codex?.env["FF_PANE_WINDOW_TOKEN"] ?? "";
      const joined = codex?.args.join("\n") ?? "";
      expect(joined).not.toContain("--dangerously-bypass-hook-trust");
      expect(joined).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(codex?.env["FF_PANE_WRITE_ROOTS"]).toBeUndefined();
      expect(joined).not.toContain("features.hooks");
      expect(joined).not.toContain("hooks.PermissionRequest");
      expect(joined).not.toContain("hooks.Stop");
      expect(joined).not.toMatch(/cmd\.exe|powershell|\.cmd|\.bat/i);
      expect(joined).not.toContain(codexToken);
      const notifyArg = codex?.args.find((arg) => arg.startsWith("notify=[")) ?? "";
      const notifyArgv = JSON.parse(notifyArg.slice("notify=".length)) as string[];
      expect(notifyArgv).toHaveLength(2);
      expect(notifyArgv[0]?.toLowerCase()).toMatch(/node(?:\.exe)?$/);
      expect(notifyArgv[1]).toContain("workbench-hook.mjs");
      expect(notifyArgv.join("\n")).not.toContain(codexToken);
    } finally {
      releaseWindowHooks(windowId);
      releaseWindowHooks("win-codex");
    }
  });
});

describe("launchCliWindow 技能挂载（T11.9）", () => {
  it("Claude 带上 --plugin-dir；Codex 把技能清单接在角色说明后面；结果里带挂载情况", async () => {
    const captured: { args: readonly string[] }[] = [];
    const manager = {
      aliveCount: () => 0,
      create: (input: { direct: { args: readonly string[] } }) => {
        captured.push({ args: [...input.direct.args] });
        return { id: `term-${captured.length}` };
      },
    } as unknown as PtyManager;
    const report = {
      mounted: ["codex-image-studio"],
      skipped: [{ name: "gone", reason: "not-in-library" as const }],
    };
    const asked: string[] = [];
    const deps = {
      manager,
      getProvider: async () => ({
        id: "prov",
        name: "Local",
        templateId: "local-login",
        defaultModelId: "sonnet",
      }),
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
      authRegistry: createWorkbenchAuthRegistry(),
      hookScriptPath: join(fakeBin, "workbench-hook.mjs"),
      loadRoleInjection: async () => ({ developerInstructions: "ROLE TEXT" }),
      resolveSkillMounts: async (input: {
        readonly windowId: string;
        readonly projectRoot: string;
        readonly runtime: "claude-code" | "codex" | "grok";
      }) => {
        asked.push(`${input.windowId}:${input.runtime}`);
        return input.runtime === "claude-code"
          ? { claudePluginDir: "D:mountswin-skill-claude", report }
          : { instructions: "## 本项目启用的技能\n- codex-image-studio：x", report };
      },
    };
    writeFileSync(join(fakeBin, "workbench-hook.mjs"), "process.exit(0)\n", "utf8");
    try {
      const claude = await launchCliWindow(
        {
          windowId: "win-skill-claude",
          projectId: "proj-role" as never,
          projectRoot: fakeBin,
          kind: "claude" as const,
          route: localRoute(),
          cols: 80,
          rows: 24,
          initialPrompt: "hi",
        },
        deps,
      );
      const claudeArgs = captured.at(-1)?.args ?? [];
      const flag = claudeArgs.indexOf("--plugin-dir");
      expect(flag).toBeGreaterThanOrEqual(0);
      expect(claudeArgs[flag + 1]).toBe("D:mountswin-skill-claude");
      expect(claudeArgs.at(-1)).toBe("hi");
      expect(claude.skills).toEqual(report);

      const codex = await launchCliWindow(
        {
          windowId: "win-skill-codex",
          projectId: "proj-role" as never,
          projectRoot: fakeBin,
          kind: "codex" as const,
          route: localRoute(),
          cols: 80,
          rows: 24,
        },
        deps,
      );
      const instructions =
        captured.at(-1)?.args.find((arg) => arg.startsWith("developer_instructions=")) ?? "";
      const text = JSON.parse(instructions.slice("developer_instructions=".length)) as string;
      expect(text.startsWith("ROLE TEXT\n\n## 本项目启用的技能")).toBe(true);
      expect(captured.at(-1)?.args).not.toContain("--plugin-dir");
      expect(codex.skills).toEqual(report);
      expect(asked).toEqual(["win-skill-claude:claude-code", "win-skill-codex:codex"]);
    } finally {
      releaseWindowHooks("win-skill-claude");
      releaseWindowHooks("win-skill-codex");
    }
  });
});
