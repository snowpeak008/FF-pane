/**
 * T10.6'：启动 / 续接 / 重启后角色仍在；启动参数带 hooks 且不含令牌明文。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createWindowTokenRegistry } from "@ff-pane/core";
import type { AgentProfile, ProjectWorkbenchLayout } from "@ff-pane/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PtyManager } from "../src/main/terminal/manager";
import { createWorkbenchAuthRegistry } from "../src/main/workbench/auth-registry";
import { releaseWindowHooks } from "../src/main/workbench/hook-launch";
import { launchCliWindow } from "../src/main/workbench/launch-cli";
import { WorkbenchMcpTempRegistry } from "../src/main/workbench/mcp-temp";

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

function profile(runtime: "claude-code" | "codex"): AgentProfile {
  return {
    id: "prof",
    name: runtime,
    runtime,
    providerId: "prov",
    defaultRole: "worker",
    connectionMode: "local_cli",
    model: "sonnet",
    permissionPreset: {
      readPaths: ["**"],
      writePaths: ["**"],
      shell: "allowed",
      network: false,
      dangerousOpsRequireApproval: true,
    },
  } as unknown as AgentProfile;
}

function layout(windowId: string, role: string): ProjectWorkbenchLayout {
  return {
    projectId: "proj-role" as never,
    tabs: [{ id: "tab-1", title: "Tab", root: { type: "leaf", windowId } }],
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
      getProfile: async (id: string) => (id === "prof" ? profile("claude-code") : undefined),
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
          profileId: "prof",
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
      expect(first?.env["FF_PANE_WB_PIPE"]).toBe("\\\\.\\pipe\\ff-pane-wb-test");
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
      expect(settingsBody).not.toMatch(/\.cmd|cmd\.exe|powershell|ELECTRON_RUN_AS_NODE/i);

      await launchCliWindow(
        {
          windowId,
          projectId: "proj-role" as never,
          projectRoot: fakeBin,
          profileId: "prof",
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
          profileId: "prof",
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
          profileId: "prof",
          cols: 80,
          rows: 24,
          role: "planner",
        },
        {
          ...deps,
          authRegistry: codexRegistry,
          tokenRegistry: codexTokens,
          getProfile: async () => profile("codex"),
        },
      );
      expect(codexRegistry.get("win-codex")?.role).toBe("planner");
      const codex = captured.at(-1);
      const codexToken = codex?.env["FF_PANE_WINDOW_TOKEN"] ?? "";
      const joined = codex?.args.join("\n") ?? "";
      expect(joined).not.toContain("--dangerously-bypass-hook-trust");
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
