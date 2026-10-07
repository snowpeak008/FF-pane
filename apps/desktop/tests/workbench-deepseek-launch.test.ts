/**
 * T10.17：没配 DeepSeek 这一路会拒绝。配了则启动本机 Claude，
 * 地址和模型进这个进程的环境，不写用户的 Claude 配置。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createWindowTokenRegistry } from "@ff-pane/core";
import {
  type ApiKeyRef,
  DEEPSEEK_ANTHROPIC_BASE_URL,
  type Provider,
  type ProviderId,
} from "@ff-pane/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PtyManager } from "../src/main/terminal/manager";
import { createWorkbenchAuthRegistry } from "../src/main/workbench/auth-registry";
import { launchCliWindow, WorkbenchCliLaunchError } from "../src/main/workbench/launch-cli";
import { WorkbenchMcpTempRegistry } from "../src/main/workbench/mcp-temp";
import type { LaunchCliRoute } from "../src/main/workbench/resolve-config";

const fakeBin = mkdtempSync(join(tmpdir(), "ffpane-deepseek-launch-"));
const projectRoot = mkdtempSync(join(tmpdir(), "ffpane-deepseek-proj-"));
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
      'IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" ) ELSE ( SET "_prog=node" )',
      'endLocal & "%_prog%"  "%dp0%\\node_modules\\claude\\bin\\claude.js" %*',
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      "",
    ].join("\r\n"),
    "utf8",
  );
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
  rmSync(projectRoot, { recursive: true, force: true });
});

function route(partial?: Partial<LaunchCliRoute>): LaunchCliRoute {
  return {
    connectionMode: "relay",
    providerId: "prov-ds",
    providerName: "DeepSeek",
    configId: "cfg" as LaunchCliRoute["configId"],
    configName: "默认配置",
    model: "deepseek-chat",
    reasoningEffort: "high",
    ...partial,
  };
}

function provider(baseUrl?: string): Provider {
  return {
    id: "prov-ds" as ProviderId,
    name: "DeepSeek",
    templateId: "deepseek",
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    apiKeyRef: "ref" as ApiKeyRef,
    enabled: true,
    models: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("launchCliWindow DeepSeek", () => {
  it("启动的是 Claude 的参数，地址和模型只在这个进程里，不写用户配置", async () => {
    const captured: { env: Record<string, string>; args: readonly string[] }[] = [];
    const manager = {
      aliveCount: () => 0,
      create: (input: { env: Record<string, string>; direct: { args: readonly string[] } }) => {
        captured.push({ env: { ...input.env }, args: [...input.direct.args] });
        return { id: `term-${captured.length}` };
      },
    } as unknown as PtyManager;
    const secret = "deepseek-secret-value";
    const result = await launchCliWindow(
      {
        windowId: "win-deepseek",
        projectId: "proj" as never,
        projectRoot,
        kind: "deepseek",
        route: route(),
        cols: 80,
        rows: 24,
        role: "worker",
        permission: "edit",
      },
      {
        manager,
        getProvider: async () => provider(),
        revealSecret: async () => secret,
        getMaxWorkbenchWindows: async () => 8,
        isKnowledgeToolEnabled: async () => false,
        getKnowledgeToolSettings: async () => undefined,
        indexDbFile: join(projectRoot, "index.db"),
        moduleDir: fakeBin,
        mcpRegistry: new WorkbenchMcpTempRegistry(),
        clampMax: (value: unknown) => (typeof value === "number" ? value : 8),
        limitErrorPrefix: "limit",
        tokenRegistry: createWindowTokenRegistry(),
        authRegistry: createWorkbenchAuthRegistry(),
        controlPipe: "\\\\.\\pipe\\ff-pane-wb-deepseek",
      },
    );
    expect(result.kind).toBe("deepseek");
    const executable = result.command.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
    expect(executable.startsWith("claude")).toBe(true);
    expect(result.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/i);
    const args = captured[0]?.args ?? [];
    const env = captured[0]?.env ?? {};
    expect(args).toContain("--session-id");
    expect(args).toContain("--model");
    expect(args).toContain("deepseek-chat");
    expect(args).toContain("--effort");
    expect(args).toContain("high");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("acceptEdits");
    expect(args).toContain("--mcp-config");
    expect(args).toContain("--strict-mcp-config");
    expect(env["ANTHROPIC_BASE_URL"]).toBe(DEEPSEEK_ANTHROPIC_BASE_URL);
    expect(env["ANTHROPIC_MODEL"]).toBe("deepseek-chat");
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe(secret);
    expect(env["ANTHROPIC_DEFAULT_OPUS_MODEL"]).toBe("deepseek-chat");
    expect(env["CLAUDE_CONFIG_DIR"]).toBeUndefined();
    expect(args.join("\n")).not.toContain(secret);
    const homeClaude = join(homedir(), ".claude").toLowerCase();
    const surfaces = [...args, ...Object.values(env)].join("\n").toLowerCase();
    expect(surfaces).not.toContain(homeClaude);
    expect(existsSync(join(projectRoot, ".claude"))).toBe(false);
    const mcpFlag = args.indexOf("--mcp-config");
    const mcpPath = mcpFlag >= 0 ? args[mcpFlag + 1] : undefined;
    expect(mcpPath).toBeDefined();
    if (mcpPath !== undefined) {
      expect(mcpPath.toLowerCase().startsWith(tmpdir().toLowerCase())).toBe(true);
      const mcpBody = readFileSync(mcpPath, "utf8");
      expect(mcpBody).not.toContain(secret);
      expect(mcpBody).toContain("ffpane-workbench");
    }
  });

  it("手填的地址覆盖默认地址", async () => {
    const captured: { env: Record<string, string> }[] = [];
    const manager = {
      aliveCount: () => 0,
      create: (input: { env: Record<string, string> }) => {
        captured.push({ env: { ...input.env } });
        return { id: "term-custom" };
      },
    } as unknown as PtyManager;
    await launchCliWindow(
      {
        windowId: "win-deepseek-custom",
        projectId: "proj" as never,
        projectRoot,
        kind: "deepseek",
        route: route({ model: "deepseek-reasoner" }),
        cols: 80,
        rows: 24,
      },
      {
        manager,
        getProvider: async () => provider("https://relay.example/anthropic"),
        revealSecret: async () => "another-secret",
        getMaxWorkbenchWindows: async () => 8,
        isKnowledgeToolEnabled: async () => false,
        getKnowledgeToolSettings: async () => undefined,
        indexDbFile: join(projectRoot, "index.db"),
        moduleDir: fakeBin,
        mcpRegistry: new WorkbenchMcpTempRegistry(),
        clampMax: (value: unknown) => (typeof value === "number" ? value : 8),
        limitErrorPrefix: "limit",
        tokenRegistry: createWindowTokenRegistry(),
        authRegistry: createWorkbenchAuthRegistry(),
      },
    );
    expect(captured[0]?.env["ANTHROPIC_BASE_URL"]).toBe("https://relay.example/anthropic");
    expect(captured[0]?.env["ANTHROPIC_MODEL"]).toBe("deepseek-reasoner");
  });

  it("续接仍用 Claude 的 --resume，并带上 DeepSeek 的地址", async () => {
    const captured: { env: Record<string, string>; args: readonly string[] }[] = [];
    const manager = {
      aliveCount: () => 0,
      create: (input: { env: Record<string, string>; direct: { args: readonly string[] } }) => {
        captured.push({ env: { ...input.env }, args: [...input.direct.args] });
        return { id: "term-resume" };
      },
    } as unknown as PtyManager;
    const sessionId = "11111111-1111-4111-8111-111111111111";
    await launchCliWindow(
      {
        windowId: "win-deepseek-resume",
        projectId: "proj" as never,
        projectRoot,
        kind: "deepseek",
        route: route(),
        cols: 80,
        rows: 24,
        resume: true,
        nativeSessionId: sessionId,
      },
      {
        manager,
        getProvider: async () => provider(),
        revealSecret: async () => "resume-secret",
        getMaxWorkbenchWindows: async () => 8,
        isKnowledgeToolEnabled: async () => false,
        getKnowledgeToolSettings: async () => undefined,
        indexDbFile: join(projectRoot, "index.db"),
        moduleDir: fakeBin,
        mcpRegistry: new WorkbenchMcpTempRegistry(),
        clampMax: (value: unknown) => (typeof value === "number" ? value : 8),
        limitErrorPrefix: "limit",
        tokenRegistry: createWindowTokenRegistry(),
        authRegistry: createWorkbenchAuthRegistry(),
      },
    );
    const args = captured[0]?.args ?? [];
    expect(args).toContain("--resume");
    expect(args).toContain(sessionId);
    expect(args).not.toContain("--session-id");
    expect(captured[0]?.env["ANTHROPIC_BASE_URL"]).toBe(DEEPSEEK_ANTHROPIC_BASE_URL);
  });

  it("没有密钥就拒绝启动", async () => {
    const manager = {
      aliveCount: () => 0,
      create: () => {
        throw new Error("should not start");
      },
    } as unknown as PtyManager;
    await expect(
      launchCliWindow(
        {
          windowId: "win-deepseek-nokey",
          projectId: "proj" as never,
          projectRoot,
          kind: "deepseek",
          route: route(),
          cols: 80,
          rows: 24,
        },
        {
          manager,
          getProvider: async () => provider(),
          revealSecret: async () => undefined,
          getMaxWorkbenchWindows: async () => 8,
          isKnowledgeToolEnabled: async () => false,
          getKnowledgeToolSettings: async () => undefined,
          indexDbFile: join(projectRoot, "index.db"),
          moduleDir: fakeBin,
          mcpRegistry: new WorkbenchMcpTempRegistry(),
          clampMax: (value: unknown) => (typeof value === "number" ? value : 8),
          limitErrorPrefix: "limit",
          tokenRegistry: createWindowTokenRegistry(),
          authRegistry: createWorkbenchAuthRegistry(),
        },
      ),
    ).rejects.toBeInstanceOf(WorkbenchCliLaunchError);
    expect(existsSync(join(projectRoot, ".claude"))).toBe(false);
  });
});
