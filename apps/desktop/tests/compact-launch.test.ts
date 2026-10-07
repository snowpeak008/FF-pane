/**
 * T10.20：压缩比例只传给管理者这一次进程。不写用户配置文件。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createWindowTokenRegistry } from "@ff-pane/core";
import {
  type ApiKeyRef,
  GROK_COMPACT_PERCENT_CAP,
  type Provider,
  type ProviderId,
  type WorkbenchRole,
} from "@ff-pane/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PtyManager } from "../src/main/terminal/manager";
import { createWorkbenchAuthRegistry } from "../src/main/workbench/auth-registry";
import {
  CLAUDE_AUTO_COMPACT_WINDOW_ENV,
  CLAUDE_AUTOCOMPACT_PCT_ENV,
  CODEX_AUTO_COMPACT_TOKEN_KEY,
  GROK_AUTO_COMPACT_PERCENT_ENV,
  resolveManagerCompact,
} from "../src/main/workbench/compact-launch";
import { grokProjectConfigPath } from "../src/main/workbench/grok-mcp-config";
import { launchCliWindow } from "../src/main/workbench/launch-cli";
import { WorkbenchMcpTempRegistry } from "../src/main/workbench/mcp-temp";
import type { LaunchCliRoute } from "../src/main/workbench/resolve-config";

const COMPACT_ENV_KEYS = [
  CLAUDE_AUTO_COMPACT_WINDOW_ENV,
  CLAUDE_AUTOCOMPACT_PCT_ENV,
  GROK_AUTO_COMPACT_PERCENT_ENV,
] as const;

const OTHER_ROLES = ["worker", "planner", "reviewer", "supervisor", "none"] as const;

const fakeBin = mkdtempSync(join(tmpdir(), "ffpane-compact-bin-"));
const projectRoot = mkdtempSync(join(tmpdir(), "ffpane-compact-proj-"));
const savedEnv = new Map<string, string | undefined>();
let restorePath: () => void = () => undefined;

function writeShim(name: string): void {
  const bin = join(fakeBin, "node_modules", name, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, `${name}.js`), "process.exit(0)\n", "utf8");
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
  for (const key of COMPACT_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  writeShim("claude");
  writeShim("codex");
  writeShim("grok");
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
  for (const key of COMPACT_ENV_KEYS) {
    const previous = savedEnv.get(key);
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
  rmSync(fakeBin, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

function assertPlainToken(value: string): void {
  expect(value).toMatch(/^\d+$/);
  expect(value.toLowerCase()).not.toContain("k");
}

function assertNoUserConfig(env: Record<string, string>, args: readonly string[]): void {
  const blob = `${JSON.stringify(env)}\n${args.join("\n")}`.toLowerCase();
  const home = homedir().toLowerCase();
  for (const dir of [".claude", ".codex", ".grok"]) {
    expect(blob).not.toContain(join(home, dir).toLowerCase());
  }
}

describe("resolveManagerCompact", () => {
  it("不是管理者、或不指定、或超出 50 到 90，什么都不传", () => {
    for (const role of OTHER_ROLES) {
      for (const kind of ["claude", "codex", "grok", "deepseek"] as const) {
        expect(resolveManagerCompact({ role, kind, percent: 70, model: "claude-sonnet" })).toEqual({
          env: {},
        });
      }
    }
    for (const percent of [undefined, 49, 91, 70.5, "70", "500k"]) {
      expect(
        resolveManagerCompact({
          role: "manager",
          kind: "claude",
          percent,
          model: "claude-sonnet",
        }),
      ).toEqual({ env: {} });
    }
  });

  it("Claude 和 DeepSeek 同时给窗口 token 和百分比，Grok 只给百分比，Codex 换成 token", () => {
    const claude = resolveManagerCompact({
      role: "manager",
      kind: "claude",
      percent: 80,
      model: "claude-sonnet",
    });
    expect(claude.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV]).toBe("200000");
    expect(claude.env[CLAUDE_AUTOCOMPACT_PCT_ENV]).toBe("80");
    expect(claude.env[GROK_AUTO_COMPACT_PERCENT_ENV]).toBeUndefined();
    expect(claude.codexTokenLimit).toBeUndefined();
    assertPlainToken(claude.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV] ?? "");

    const deepseek = resolveManagerCompact({
      role: "manager",
      kind: "deepseek",
      percent: 60,
      model: "deepseek-v4-pro",
    });
    expect(deepseek.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV]).toBe("128000");
    expect(deepseek.env[CLAUDE_AUTOCOMPACT_PCT_ENV]).toBe("60");
    assertPlainToken(deepseek.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV] ?? "");

    const grok = resolveManagerCompact({ role: "manager", kind: "grok", percent: 70 });
    expect(grok.env).toEqual({ [GROK_AUTO_COMPACT_PERCENT_ENV]: "70" });
    const grokLate = resolveManagerCompact({ role: "manager", kind: "grok", percent: 90 });
    expect(grokLate.env[GROK_AUTO_COMPACT_PERCENT_ENV]).toBe(String(GROK_COMPACT_PERCENT_CAP));

    const codex = resolveManagerCompact({
      role: "manager",
      kind: "codex",
      percent: 70,
      model: "gpt-5",
    });
    expect(codex.env).toEqual({});
    expect(codex.codexTokenLimit).toBe("280000");
    assertPlainToken(codex.codexTokenLimit ?? "");
    const codexCap = resolveManagerCompact({
      role: "manager",
      kind: "codex",
      percent: 90,
      model: "gpt-5",
    });
    expect(Number(codexCap.codexTokenLimit)).toBe(360_000);
  });
});

function localRoute(model?: string): LaunchCliRoute {
  return {
    connectionMode: "local_cli",
    configId: "cfg" as LaunchCliRoute["configId"],
    configName: "默认配置",
    ...(model !== undefined ? { model } : {}),
  };
}

function deepseekProvider(): Provider {
  return {
    id: "prov-ds" as ProviderId,
    name: "DeepSeek",
    templateId: "deepseek",
    apiKeyRef: "ref" as ApiKeyRef,
    enabled: true,
    models: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

async function launch(input: {
  readonly windowId: string;
  readonly kind: "claude" | "codex" | "grok" | "deepseek";
  readonly role?: WorkbenchRole;
  readonly compactPercent?: number;
  readonly model?: string;
  readonly resume?: boolean;
  readonly registryRole?: WorkbenchRole;
}): Promise<{ readonly env: Record<string, string>; readonly args: readonly string[] }> {
  const captured: { env: Record<string, string>; args: readonly string[] }[] = [];
  const manager = {
    aliveCount: () => 0,
    create: (created: { env: Record<string, string>; direct: { args: readonly string[] } }) => {
      captured.push({ env: { ...created.env }, args: [...created.direct.args] });
      return { id: `term-${input.windowId}` };
    },
  } as unknown as PtyManager;
  const authRegistry = createWorkbenchAuthRegistry();
  if (input.registryRole !== undefined) {
    authRegistry.upsert(
      { id: input.windowId, permission: "edit", openedBy: "user", role: input.registryRole },
      "proj" as never,
    );
  }
  const relay = input.kind === "deepseek";
  await launchCliWindow(
    {
      windowId: input.windowId,
      projectId: "proj" as never,
      projectRoot,
      kind: input.kind,
      route: relay
        ? {
            connectionMode: "relay",
            providerId: "prov-ds",
            providerName: "DeepSeek",
            configId: "cfg" as LaunchCliRoute["configId"],
            configName: "默认配置",
            model: input.model ?? "deepseek-v4-pro",
          }
        : localRoute(input.model),
      cols: 80,
      rows: 24,
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.compactPercent !== undefined ? { compactPercent: input.compactPercent } : {}),
      ...(input.resume === true
        ? { resume: true, nativeSessionId: "11111111-1111-4111-8111-111111111111" }
        : {}),
    },
    {
      manager,
      getProvider: async () => (relay ? deepseekProvider() : undefined),
      revealSecret: async () => (relay ? "deepseek-secret-value" : undefined),
      getMaxWorkbenchWindows: async () => 8,
      isKnowledgeToolEnabled: async () => false,
      getKnowledgeToolSettings: async () => undefined,
      indexDbFile: join(projectRoot, "index.db"),
      moduleDir: fakeBin,
      mcpRegistry: new WorkbenchMcpTempRegistry(),
      clampMax: (value: unknown) => (typeof value === "number" ? value : 8),
      limitErrorPrefix: "limit",
      tokenRegistry: createWindowTokenRegistry(),
      authRegistry,
      controlPipe: "\\\\.\\pipe\\ff-pane-wb-compact",
      hookScriptPath: join(fakeBin, "workbench-hook.mjs"),
    },
  );
  const found = captured[0];
  if (found === undefined) {
    throw new Error("launch did not create a process");
  }
  return found;
}

describe("launchCliWindow 管理者压缩", () => {
  it("只有管理者会带上环境变量或 -c；不指定和其他角色不带；不写用户配置", async () => {
    const claude = await launch({
      windowId: "mgr-claude",
      kind: "claude",
      role: "manager",
      compactPercent: 80,
      model: "claude-sonnet",
    });
    expect(claude.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV]).toBe("200000");
    expect(claude.env[CLAUDE_AUTOCOMPACT_PCT_ENV]).toBe("80");
    expect(claude.env[GROK_AUTO_COMPACT_PERCENT_ENV]).toBeUndefined();
    expect(claude.args.join("\n")).not.toContain(CODEX_AUTO_COMPACT_TOKEN_KEY);
    assertPlainToken(claude.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV] ?? "");
    assertNoUserConfig(claude.env, claude.args);

    const resumed = await launch({
      windowId: "mgr-claude-resume",
      kind: "claude",
      role: "manager",
      compactPercent: 80,
      model: "claude-sonnet",
      resume: true,
    });
    expect(resumed.env[CLAUDE_AUTOCOMPACT_PCT_ENV]).toBe("80");
    expect(resumed.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV]).toBe("200000");

    const unspecified = await launch({
      windowId: "mgr-claude-default",
      kind: "claude",
      role: "manager",
      model: "claude-sonnet",
    });
    expect(unspecified.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV]).toBeUndefined();
    expect(unspecified.env[CLAUDE_AUTOCOMPACT_PCT_ENV]).toBeUndefined();

    for (const role of OTHER_ROLES) {
      const other = await launch({
        windowId: `claude-${role}`,
        kind: "claude",
        role,
        compactPercent: 80,
        model: "claude-sonnet",
      });
      expect(other.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV]).toBeUndefined();
      expect(other.env[CLAUDE_AUTOCOMPACT_PCT_ENV]).toBeUndefined();
      expect(other.env[GROK_AUTO_COMPACT_PERCENT_ENV]).toBeUndefined();
      expect(other.args.join("\n")).not.toContain(CODEX_AUTO_COMPACT_TOKEN_KEY);
    }

    const locked = await launch({
      windowId: "locked-worker",
      kind: "claude",
      role: "manager",
      registryRole: "worker",
      compactPercent: 80,
      model: "claude-sonnet",
    });
    expect(locked.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV]).toBeUndefined();
    expect(locked.env[CLAUDE_AUTOCOMPACT_PCT_ENV]).toBeUndefined();

    const codex = await launch({
      windowId: "mgr-codex",
      kind: "codex",
      role: "manager",
      compactPercent: 70,
      model: "gpt-5",
    });
    expect(codex.args).toContain(`-c`);
    expect(codex.args).toContain(`${CODEX_AUTO_COMPACT_TOKEN_KEY}=280000`);
    expect(codex.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV]).toBeUndefined();
    expect(codex.env[GROK_AUTO_COMPACT_PERCENT_ENV]).toBeUndefined();
    assertNoUserConfig(codex.env, codex.args);
    const codexWorker = await launch({
      windowId: "codex-worker",
      kind: "codex",
      role: "worker",
      compactPercent: 70,
      model: "gpt-5",
    });
    expect(codexWorker.args.join("\n")).not.toContain(CODEX_AUTO_COMPACT_TOKEN_KEY);

    const grok = await launch({
      windowId: "mgr-grok",
      kind: "grok",
      role: "manager",
      compactPercent: 90,
    });
    expect(grok.env[GROK_AUTO_COMPACT_PERCENT_ENV]).toBe("85");
    expect(grok.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV]).toBeUndefined();
    expect(grok.args.join("\n")).not.toContain(CODEX_AUTO_COMPACT_TOKEN_KEY);
    const grokConfig = grokProjectConfigPath(projectRoot);
    expect(grokConfig.startsWith(projectRoot)).toBe(true);
    expect(grokConfig.toLowerCase().includes(join(homedir(), ".grok").toLowerCase())).toBe(false);
    assertNoUserConfig(grok.env, grok.args);
    const grokWorker = await launch({
      windowId: "grok-supervisor",
      kind: "grok",
      role: "supervisor",
      compactPercent: 70,
    });
    expect(grokWorker.env[GROK_AUTO_COMPACT_PERCENT_ENV]).toBeUndefined();

    const deepseek = await launch({
      windowId: "mgr-deepseek",
      kind: "deepseek",
      role: "manager",
      compactPercent: 60,
      model: "deepseek-v4-pro",
    });
    expect(deepseek.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV]).toBe("128000");
    expect(deepseek.env[CLAUDE_AUTOCOMPACT_PCT_ENV]).toBe("60");
    expect(deepseek.env[GROK_AUTO_COMPACT_PERCENT_ENV]).toBeUndefined();
    assertPlainToken(deepseek.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV] ?? "");
    assertNoUserConfig(deepseek.env, deepseek.args);
    const deepseekPlanner = await launch({
      windowId: "deepseek-planner",
      kind: "deepseek",
      role: "planner",
      compactPercent: 60,
      model: "deepseek-v4-pro",
    });
    expect(deepseekPlanner.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV]).toBeUndefined();
    expect(deepseekPlanner.env[CLAUDE_AUTOCOMPACT_PCT_ENV]).toBeUndefined();
  });
});
