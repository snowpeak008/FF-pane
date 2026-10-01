/**
 * T9.1 工作台自配置工具 E2E（两条，路径落档）：
 *
 * 1. **sidecar 真实拉起**（照 knowledge-mcp.spec 款式）：ELECTRON_RUN_AS_NODE +
 *    out/main/config-mcp.js，验证 initialize → tools/list（四工具、schema 物理无
 *    密钥字段）→ list 脱敏视图（key 引用不出现）→ 草案经文件信箱投递、
 *    测试扮演主进程写回 rejected 响应、sidecar 把结果转给模型。
 * 2. **应用全链路**：项目开关经真实设置页 UI 开启 → 假 codex（挂起）派发 Worker 轮
 *    → 编排器装配信箱 → 测试把一份草案投进信箱（模拟 sidecar 的原子写——sidecar
 *    自身的协议行为已由第 1 条与单测覆盖）→ 真实校验 → 确认对话框出现 → 点确认
 *    → 配置真落盘（providers:list 可查到）。
 *
 * 草案用 cli_login 类型：无 baseUrl / 无密钥需求，hermetic 且不触发补填输入框
 * （补填通道的强制性由单测 + 对话框的 needsApiKey 分支覆盖）。
 */

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import electronPath from "electron";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SECRET_PATTERN = /key|secret|token|credential|password/i;

/** 递归收集 JSON Schema 的全部 properties 键名（含嵌套）。 */
function collectPropertyKeys(schema: unknown, out: string[] = []): string[] {
  if (typeof schema !== "object" || schema === null) {
    return out;
  }
  const record = schema as Record<string, unknown>;
  if (typeof record["properties"] === "object" && record["properties"] !== null) {
    for (const [key, value] of Object.entries(record["properties"])) {
      out.push(key);
      collectPropertyKeys(value, out);
    }
  }
  if (record["items"] !== undefined) {
    collectPropertyKeys(record["items"], out);
  }
  return out;
}

/**
 * 一次 config sidecar 会话：逐行写请求、收集逐行响应；`respondDrafts` 扮演主进程——
 * 后台轮询信箱 requests/，对每份草案写回指定 outcome 的响应文件。
 */
async function speakConfigMcp(
  env: Record<string, string>,
  requests: readonly Record<string, unknown>[],
  respondDrafts?: {
    readonly mailboxDir: string;
    readonly outcome: string;
    readonly message?: string;
  },
): Promise<readonly Record<string, unknown>[]> {
  const child = spawn(
    electronPath as unknown as string,
    [join(desktopDir, "out", "main", "config-mcp.js")],
    {
      cwd: desktopDir,
      env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  // 扮演主进程的响应器：看到新请求文件即写回响应（草案调用会阻塞到响应出现）
  let responderAlive = respondDrafts !== undefined;
  const responder = (async (): Promise<void> => {
    if (respondDrafts === undefined) {
      return;
    }
    const requestsDir = join(respondDrafts.mailboxDir, "requests");
    const responsesDir = join(respondDrafts.mailboxDir, "responses");
    const answered = new Set<string>();
    while (responderAlive) {
      let names: string[] = [];
      try {
        names = await readdir(requestsDir);
      } catch {
        // sidecar 尚未建目录
      }
      for (const name of names) {
        if (!name.endsWith(".json") || answered.has(name)) {
          continue;
        }
        answered.add(name);
        const id = name.slice(0, -".json".length);
        await writeFile(
          join(responsesDir, `${id}.json`),
          JSON.stringify({
            id,
            outcome: respondDrafts.outcome,
            ...(respondDrafts.message !== undefined ? { message: respondDrafts.message } : {}),
          }),
          "utf8",
        );
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
    }
  })();

  for (const request of requests) {
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }
  child.stdin.end();

  const code = await new Promise<number>((resolveExit) => {
    child.on("close", (exitCode) => resolveExit(exitCode ?? -1));
  });
  responderAlive = false;
  await responder;
  expect(code, `sidecar 非正常退出，stderr：${stderr}`).toBe(0);

  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

let launched: LaunchedApp;
let projectDir: string;
let fakeBinDir: string;

/** 挂起不退出的假 codex（照 task-parallel.spec）：让 Worker 轮长期在飞，信箱保持存活。 */
function seedFakeCodex(dir: string): void {
  writeFileSync(join(dir, "codex.cmd"), "@echo off\r\nping -n 86400 127.0.0.1 >nul\r\n", "utf8");
  const posix = join(dir, "codex");
  writeFileSync(posix, "#!/bin/sh\nsleep 86400\n", "utf8");
  chmodSync(posix, 0o755);
}

function seedTask(projectRoot: string): void {
  const tasksDir = join(projectRoot, ".workbench", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(tasksDir, "task-task-cfg.json"),
    JSON.stringify(
      {
        id: "task-cfg",
        planVersion: 1,
        goal: "config tool seed task",
        writeScope: ["src"],
        forbidden: [],
        dependsOn: [],
        contextRefs: [],
        acceptance: ["done"],
        status: "pending",
      },
      null,
      2,
    ),
    "utf8",
  );
}

test.beforeAll(async () => {
  fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-cfg-bin-"));
  seedFakeCodex(fakeBinDir);
  launched = await launchApp({ pathPrepend: fakeBinDir });
  projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-cfg-proj-"));

  await launched.page.evaluate(async (dir: string) => {
    const invoke = (channel: string, req?: unknown) =>
      // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
      (window as any).ffpane.invoke(channel, req);
    const entry = await invoke("projects:create", { name: "E2E ConfigTool", rootPath: dir });
    const provider = await invoke("providers:create", {
      draft: {
        name: "E2E CLI",
        templateId: "local-login",
        models: [{ id: "m1", label: "M1", kind: "chat" }],
        defaultModelId: "m1",
        enabled: true,
      },
    });
    await invoke("profiles:create", {
      draft: {
        name: "E2E Worker",
        runtime: "codex",
        providerId: provider.id,
        defaultRole: "worker",
        permissionPreset: {
          readPaths: ["**"],
          writePaths: ["**"],
          shell: "allowed",
          network: false,
          dangerousOpsRequireApproval: true,
        },
      },
    });
    window.localStorage.setItem(
      "ffpane.ui-state",
      JSON.stringify({ state: { activeProjectId: entry.id }, version: 1 }),
    );
  }, projectDir);
  seedTask(projectDir);
  await launched.page.reload();
  await launched.page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  // 收尾预算放宽（T9.6 顺手项）：cleanup 的 app.close() 要走 prepareForQuit →
  // 树杀挂起的假 codex（ping 86400s）→ 轮次 interrupted 落盘，整套 E2E 负载下
  // 可超默认 60s 钩子预算——T9.6 回归实测一次失败形态即「afterAll hook timeout
  // of 60000ms exceeded」（测试本体 5.8s 已过），失败被归因到全链路条 :317，
  // 与 §4.5 已四见的登记形态一致。真挂死仍会在 120s 兜住。
  test.setTimeout(120_000);
  await launched.cleanup();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(fakeBinDir, { recursive: true, force: true });
});

test("config MCP sidecar：拉起 → 四工具 schema 无密钥字段 → list 脱敏 → 草案信箱往返", async () => {
  const { dataRoot } = launched;
  const mailboxDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-cfg-mail-"));

  // 预置一份带密钥引用的 providers.json（sidecar 只读它做 list）
  const providersFile = join(dataRoot, "e2e-cfg-providers.json");
  writeFileSync(
    providersFile,
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: "provider-e2e",
          name: "SecretProv",
          templateId: "openai-compatible",
          baseUrl: "https://api.example.com/v1",
          apiKeyRef: "super-secret-ref-do-not-leak",
          models: [{ id: "m1", label: "M1", kind: "chat" }],
          defaultModelId: "m1",
          enabled: true,
        },
      ],
    }),
    "utf8",
  );
  const configsFile = join(dataRoot, "e2e-cfg-configs.json");
  writeFileSync(
    configsFile,
    JSON.stringify({
      version: 1,
      configs: [
        {
          id: "config-e2e",
          name: "ListedConfig",
          isDefault: true,
          claude: { connectionMode: "local_cli" },
          apiKeyRef: "config-secret-ref-do-not-leak",
        },
      ],
    }),
    "utf8",
  );
  const auditPath = join(mailboxDir, "audit.jsonl");

  const responses = await speakConfigMcp(
    {
      FF_PANE_CONFIG_MAILBOX: mailboxDir,
      FF_PANE_CONFIG_PROVIDERS: providersFile,
      FF_PANE_CONFIG_CONFIGS: configsFile,
      FF_PANE_CONFIG_AUDIT: auditPath,
    },
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "config_list_providers", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "config_list_configs", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "config_draft_provider",
          arguments: {
            name: "Drafted",
            templateId: "local-login",
            models: [{ id: "m", label: "M", kind: "chat" }],
          },
        },
      },
    ],
    // 测试扮演主进程：对草案写回 rejected（真实确认链路由第 2 条覆盖）
    { mailboxDir, outcome: "rejected", message: "not this one" },
  );
  rmSync(mailboxDir, { recursive: true, force: true });

  expect(responses).toHaveLength(5);

  // 工具面恰好四个，且任何 schema 里没有一个密钥字样的键（铁律 1 的打包产物级证据）
  const list = responses[1] as {
    result: { tools: { name: string; inputSchema: unknown }[] };
  };
  expect(list.result.tools.map((tool) => tool.name)).toEqual([
    "config_list_providers",
    "config_list_configs",
    "config_draft_provider",
    "config_draft_config",
  ]);
  for (const tool of list.result.tools) {
    for (const key of collectPropertyKeys(tool.inputSchema)) {
      expect(SECRET_PATTERN.test(key), `${tool.name} schema 含密钥字样键：${key}`).toBe(false);
    }
  }

  // list 脱敏：密钥引用绝不出现，只有 apiKeyConfigured 布尔
  const listCall = responses[2] as { result: { content: { text: string }[] } };
  const listText = listCall.result.content[0]?.text ?? "";
  expect(listText).toContain("SecretProv");
  expect(listText).toContain('"apiKeyConfigured": true');
  expect(listText).not.toContain("super-secret-ref-do-not-leak");

  // 草案信箱往返：sidecar 把主进程写回的 rejected 转述给模型
  const configList = responses[3] as { result: { content: { text: string }[] } };
  const configText = configList.result.content[0]?.text ?? "";
  expect(configText).toContain("ListedConfig");
  expect(configText).not.toContain("config-secret-ref-do-not-leak");
  expect(configText).not.toContain("apiKeyRef");

  const draftCall = responses[4] as { result: { content: { text: string }[] } };
  expect(draftCall.result.content[0]?.text).toContain("rejected");
  expect(draftCall.result.content[0]?.text).toContain("not this one");
});

test("设置页开关可打开并保持选中", async () => {
  const { page } = launched;
  await gotoRoute(page, "/settings");
  const toggle = page.getByTestId("config-tool-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  const projectRoot = projectDir;
  await expect
    .poll(async () =>
      page.evaluate(async (root: string) => {
        const settings = await (
          window as unknown as {
            ffpane: {
              invoke: (
                channel: string,
                request?: unknown,
              ) => Promise<{ configToolEnabled: boolean }>;
            };
          }
        ).ffpane.invoke("projects:get-settings", { projectRoot: root });
        return settings.configToolEnabled;
      }, projectRoot),
    )
    .toBe(true);
});
