/**
 * T10.16：Grok 窗口启动写项目配置、令牌只在进程环境、开关控制知识库和自配置。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createWindowTokenRegistry, resolveProviderInjection } from "@ff-pane/core";
import type { Provider } from "@ff-pane/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PtyManager } from "../src/main/terminal/manager";
import { createWorkbenchAuthRegistry } from "../src/main/workbench/auth-registry";
import { launchCliWindow } from "../src/main/workbench/launch-cli";
import { WorkbenchMcpTempRegistry } from "../src/main/workbench/mcp-temp";
import type { LaunchCliRoute } from "../src/main/workbench/resolve-config";
import { isConfigToolCallerDenied } from "../src/mcp/config-tool";

const fakeBin = mkdtempSync(join(tmpdir(), "ffpane-grok-launch-"));
const projectRoot = mkdtempSync(join(tmpdir(), "ffpane-grok-proj-"));
let restorePath: () => void = () => undefined;

beforeAll(() => {
  const bin = join(fakeBin, "node_modules", "grok", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "grok.js"), "process.exit(0)\n", "utf8");
  writeFileSync(
    join(fakeBin, "grok.cmd"),
    [
      "@ECHO off",
      "SETLOCAL",
      "CALL :find_dp0",
      'IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" ) ELSE ( SET "_prog=node" )',
      'endLocal & "%_prog%"  "%dp0%\\node_modules\\grok\\bin\\grok.js" %*',
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
    connectionMode: "local_cli",
    configId: "cfg" as LaunchCliRoute["configId"],
    configName: "默认配置",
    ...partial,
  };
}

describe("launchCliWindow Grok", () => {
  it("开窗口写出 .grok/config.toml，令牌只在环境里，非管理者的自配置会被拒绝", async () => {
    mkdirSync(join(projectRoot, ".grok"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".grok", "config.toml"),
      '# user\n[mcp_servers.my-tool]\ncommand = "my-tool"\n',
      { encoding: "utf8" },
    );
    const captured: { env: Record<string, string>; args: readonly string[] }[] = [];
    const manager = {
      aliveCount: () => 0,
      create: (input: { env: Record<string, string>; direct: { args: readonly string[] } }) => {
        captured.push({ env: { ...input.env }, args: [...input.direct.args] });
        return { id: `term-${captured.length}` };
      },
    } as unknown as PtyManager;
    const tokenRegistry = createWindowTokenRegistry();
    const secret = "grok-secret-value";
    const result = await launchCliWindow(
      {
        windowId: "win-grok",
        projectId: "proj" as never,
        projectRoot,
        kind: "grok",
        route: route({ model: "grok-test", reasoningEffort: "low" }),
        cols: 80,
        rows: 24,
        role: "worker",
      },
      {
        manager,
        getProvider: async () => undefined,
        revealSecret: async () => secret,
        getMaxWorkbenchWindows: async () => 8,
        isKnowledgeToolEnabled: async () => true,
        isConfigToolEnabled: async () => true,
        getKnowledgeToolSettings: async () => undefined,
        indexDbFile: join(projectRoot, "index.db"),
        moduleDir: fakeBin,
        mcpRegistry: new WorkbenchMcpTempRegistry(),
        clampMax: (value: unknown) => (typeof value === "number" ? value : 8),
        limitErrorPrefix: "limit",
        tokenRegistry,
        authRegistry: createWorkbenchAuthRegistry(),
        controlPipe: "\\\\.\\pipe\\ff-pane-wb-grok",
        loadRoleInjection: async () => ({ grokRules: "按角色说明行事" }),
      },
    );
    expect(result.kind).toBe("grok");
    expect(result.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.turnSignal).toBe("manual");
    expect(result.command.toLowerCase()).toContain("grok");
    const args = captured[0]?.args ?? [];
    expect(args).toContain("--session-id");
    expect(args).toContain("--model");
    expect(args).toContain("grok-test");
    expect(args).toContain("--reasoning-effort");
    expect(args).toContain("low");
    expect(args).toContain("--rules");
    expect(args).toContain("按角色说明行事");
    expect(args.join("\n")).not.toContain("--continue");
    const body = readFileSync(join(projectRoot, ".grok", "config.toml"), "utf8");
    const issued = captured[0]?.env["FF_PANE_WINDOW_TOKEN"] ?? "";
    expect(issued.length).toBeGreaterThan(32);
    expect(body).toContain("# user");
    expect(body).toContain("[mcp_servers.my-tool]");
    expect(body).toContain("[mcp_servers.ffpane-workbench]");
    expect(body).toContain("[mcp_servers.ffpane-knowledge]");
    expect(body).toContain("[mcp_servers.ffpane-config]");
    expect(body).toContain(`${"$"}{FF_PANE_WINDOW_TOKEN}`);
    expect(body).not.toContain(issued);
    expect(body).not.toContain(secret);
    expect(args.join("\n")).not.toContain(issued);
    expect(captured[0]?.env["FF_PANE_CONFIG_CALLER_ROLE"]).toBe("worker");
    expect(isConfigToolCallerDenied(captured[0]?.env["FF_PANE_CONFIG_CALLER_ROLE"])).toBe(true);
  });

  it("中转密钥进环境变量，不进项目配置", async () => {
    const provider = {
      id: "prov-grok",
      name: "Grok 中转",
      templateId: "grok-compatible",
      baseUrl: "https://relay.example/v1",
      apiKeyRef: "ref",
      enabled: true,
      models: [],
      createdAt: 1,
      updatedAt: 1,
    } as unknown as Provider;
    const injection = resolveProviderInjection({
      provider,
      cli: "grok",
      secret: "relay-key",
    });
    expect(injection.env["XAI_API_KEY"]).toBe("relay-key");
    expect(injection.env["GROK_MODELS_BASE_URL"]).toBe("https://relay.example/v1");
    expect(injection.configOverrides).toEqual({});
  });
});
