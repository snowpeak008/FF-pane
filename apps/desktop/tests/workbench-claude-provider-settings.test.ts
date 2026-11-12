/**
 * Claude 窗口走中转来源：地址、模型进本窗口 `--settings`，盖过用户和项目 settings 的 env；
 * 密钥不落盘，apiKeyHelper 从进程环境读。本机登录不写这些。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createWindowTokenRegistry } from "@ff-pane/core";
import type { ApiKeyRef, Provider, ProviderId } from "@ff-pane/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PtyManager } from "../src/main/terminal/manager";
import { createWorkbenchAuthRegistry } from "../src/main/workbench/auth-registry";
import {
  buildClaudeProviderSettings,
  CLAUDE_KEY_ENV,
  CLAUDE_KEY_HELPER_EVENT,
  claudeKeyHelperCommand,
  readClaudeSettingsEnvNames,
} from "../src/main/workbench/claude-provider-settings";
import { launchCliWindow } from "../src/main/workbench/launch-cli";
import { WorkbenchMcpTempRegistry } from "../src/main/workbench/mcp-temp";
import type { LaunchCliRoute } from "../src/main/workbench/resolve-config";
import {
  CLAUDE_KEY_ENV as HOOK_KEY_ENV,
  CLAUDE_KEY_HELPER_EVENT as HOOK_KEY_EVENT,
} from "../src/mcp/workbench-hook";

describe("buildClaudeProviderSettings", () => {
  it("清空路由和密钥键，写入来源地址，模型全设成选中的", () => {
    const settings = buildClaudeProviderSettings({
      injectEnv: {
        ANTHROPIC_AUTH_TOKEN: "relay-secret",
        ANTHROPIC_BASE_URL: "https://relay.example",
        ANTHROPIC_MODEL: "from-provider",
      },
      model: "claude-picked",
      apiKeyHelper: "helper",
      existingEnvNames: ["ANTHROPIC_CUSTOM_MODEL_OPTION", "ENABLE_PROMPT_CACHING_1H"],
    });
    expect(settings.env["ANTHROPIC_BASE_URL"]).toBe("https://relay.example");
    expect(settings.env["ANTHROPIC_AUTH_TOKEN"]).toBe("");
    expect(settings.env["ANTHROPIC_API_KEY"]).toBe("");
    expect(settings.env["CLAUDE_CODE_USE_BEDROCK"]).toBe("");
    expect(settings.env["ANTHROPIC_CUSTOM_MODEL_OPTION"]).toBe("");
    expect(settings.env["ENABLE_PROMPT_CACHING_1H"]).toBeUndefined();
    for (const key of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ]) {
      expect(settings.env[key]).toBe("claude-picked");
    }
    expect(settings.apiKeyHelper).toBe("helper");
    expect(JSON.stringify(settings)).not.toContain("relay-secret");
  });

  it("官方来源没填地址时写官方地址，盖掉用户 settings 里的中转", () => {
    const settings = buildClaudeProviderSettings({
      injectEnv: { ANTHROPIC_API_KEY: "sk-ant" },
    });
    expect(settings.env["ANTHROPIC_BASE_URL"]).toBe("https://api.anthropic.com");
    expect(settings.env["ANTHROPIC_MODEL"]).toBe("");
    expect(settings.apiKeyHelper).toBeUndefined();
  });
});

describe("claudeKeyHelperCommand", () => {
  it("有 node 跑钩子脚本的 ApiKey 模式，命令里不含密钥", () => {
    expect(claudeKeyHelperCommand({ nodePath: "C:\\node.exe", scriptPath: "C:\\h.mjs" })).toBe(
      `"C:\\node.exe" "C:\\h.mjs" ${CLAUDE_KEY_HELPER_EVENT}`,
    );
  });

  it("没有 node 时 Windows 用系统 PowerShell 读变量", () => {
    const command = claudeKeyHelperCommand({
      scriptPath: "C:\\h.mjs",
      platform: "win32",
      systemRoot: "C:\\Windows",
    });
    expect(command).toContain("powershell.exe");
    expect(command).toContain(`$env:${CLAUDE_KEY_ENV}`);
  });

  it("钩子脚本和主进程用同一个变量名和事件名", () => {
    expect(HOOK_KEY_ENV).toBe(CLAUDE_KEY_ENV);
    expect(HOOK_KEY_EVENT).toBe(CLAUDE_KEY_HELPER_EVENT);
  });
});

describe("readClaudeSettingsEnvNames", () => {
  it("读用户和项目 settings 的 env 键名，坏文件当没有", () => {
    const root = mkdtempSync(join(tmpdir(), "ffpane-claude-envnames-"));
    try {
      const configDir = join(root, "home");
      const cwd = join(root, "proj");
      mkdirSync(configDir, { recursive: true });
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      writeFileSync(
        join(configDir, "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: "x" } }),
      );
      writeFileSync(
        join(cwd, ".claude", "settings.local.json"),
        JSON.stringify({ env: { ANTHROPIC_DEFAULT_FABLE_MODEL: "y" } }),
      );
      writeFileSync(join(cwd, ".claude", "settings.json"), "{ not json");
      expect(readClaudeSettingsEnvNames({ cwd, configDir }).sort()).toEqual([
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_DEFAULT_FABLE_MODEL",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const fakeBin = mkdtempSync(join(tmpdir(), "ffpane-claude-relay-launch-"));
const projectRoot = mkdtempSync(join(tmpdir(), "ffpane-claude-relay-proj-"));
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

function relayProvider(templateId: Provider["templateId"]): Provider {
  return {
    id: "prov-relay" as ProviderId,
    name: "Relay",
    templateId,
    baseUrl: "https://relay.example/anthropic",
    apiKeyRef: "ref" as ApiKeyRef,
    enabled: true,
    models: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

async function launchClaude(
  route: LaunchCliRoute,
  provider: Provider,
  windowId: string,
): Promise<{ env: Record<string, string>; args: readonly string[] }> {
  const captured: { env: Record<string, string>; args: readonly string[] }[] = [];
  const manager = {
    aliveCount: () => 0,
    create: (input: { env: Record<string, string>; direct: { args: readonly string[] } }) => {
      captured.push({ env: { ...input.env }, args: [...input.direct.args] });
      return { id: `term-${windowId}` };
    },
  } as unknown as PtyManager;
  await launchCliWindow(
    {
      windowId,
      projectId: "proj" as never,
      projectRoot,
      kind: "claude",
      route,
      cols: 80,
      rows: 24,
      role: "worker",
      permission: "edit",
    },
    {
      manager,
      getProvider: async () => provider,
      revealSecret: async () => "relay-secret-value",
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
  return captured[0] ?? { env: {}, args: [] };
}

function settingsOf(args: readonly string[]): Record<string, unknown> | undefined {
  const flag = args.indexOf("--settings");
  const path = flag >= 0 ? args[flag + 1] : undefined;
  return path === undefined ? undefined : JSON.parse(readFileSync(path, "utf8"));
}

describe("launchCliWindow Claude 中转", () => {
  it("地址和模型进 --settings，密钥只在进程环境，由 apiKeyHelper 读", async () => {
    const { env, args } = await launchClaude(
      {
        connectionMode: "relay",
        providerId: "prov-relay",
        providerName: "Relay",
        configId: "cfg" as LaunchCliRoute["configId"],
        configName: "默认配置",
        model: "claude-relay-model",
      },
      relayProvider("anthropic-compatible"),
      "win-claude-relay",
    );
    const settings = settingsOf(args);
    expect(settings).toBeDefined();
    const settingsEnv = (settings?.["env"] ?? {}) as Record<string, string>;
    expect(settingsEnv["ANTHROPIC_BASE_URL"]).toBe("https://relay.example/anthropic");
    expect(settingsEnv["ANTHROPIC_AUTH_TOKEN"]).toBe("");
    expect(settingsEnv["ANTHROPIC_DEFAULT_OPUS_MODEL"]).toBe("claude-relay-model");
    expect(typeof settings?.["apiKeyHelper"]).toBe("string");
    expect(JSON.stringify(settings)).not.toContain("relay-secret-value");
    expect(args.join("\n")).not.toContain("relay-secret-value");
    expect(env[CLAUDE_KEY_ENV]).toBe("relay-secret-value");
  });

  it("本机登录不写来源设置，也不放密钥变量", async () => {
    const { env, args } = await launchClaude(
      {
        connectionMode: "local_cli",
        configId: "cfg" as LaunchCliRoute["configId"],
        configName: "默认配置",
      },
      relayProvider("anthropic-compatible"),
      "win-claude-local",
    );
    const settings = settingsOf(args);
    expect(settings?.["env"]).toBeUndefined();
    expect(settings?.["apiKeyHelper"]).toBeUndefined();
    expect(env[CLAUDE_KEY_ENV]).toBeUndefined();
  });
});
