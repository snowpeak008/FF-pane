/**
 * 冒烟 6：Agent 只读检索工具的 MCP 服务端全链路（T6.6，§8.3.5 路径二）。
 *
 * 这条冒烟验证的是**装配**，而不是协议细节（后者由 mcp-protocol.test.ts 覆盖）：
 * 打包产物里的 sidecar 能不能真的被拉起、能不能以只读方式打开主进程刚建好的索引库、
 * 能不能按 MCP 协议完成 initialize → tools/list → tools/call 一个来回、审计有没有落盘。
 *
 * 关键在于它跑的是**真实的启动方式**：`ELECTRON_RUN_AS_NODE=1` + Electron 二进制 +
 * out/main/knowledge-mcp.js，与 resolveKnowledgeMcpServer 装出来的规格一致。
 * 这是单测无论如何覆盖不到的一层——better-sqlite3 的原生模块能否在 node 模式下加载、
 * WAL 库能否被第二个连接只读打开，都只有真跑一次才知道。
 *
 * 无嵌入模型 → 纯 FTS 路径（§8.3.3），故 hermetic：不联网、不需要 Provider。
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import electronPath from "electron";
import { type LaunchedApp, launchApp } from "./_launch";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 一次 MCP 会话：把若干请求逐行写进 sidecar，收集它逐行回的响应。 */
async function speakMcp(
  env: Record<string, string>,
  requests: readonly Record<string, unknown>[],
): Promise<readonly Record<string, unknown>[]> {
  const child = spawn(
    electronPath as unknown as string,
    [join(desktopDir, "out", "main", "knowledge-mcp.js")],
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

  for (const request of requests) {
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }
  child.stdin.end();

  const code = await new Promise<number>((resolveExit) => {
    child.on("close", (exitCode) => resolveExit(exitCode ?? -1));
  });
  expect(code, `sidecar 非正常退出，stderr：${stderr}`).toBe(0);

  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp();
});

test.afterAll(async () => {
  await launched.cleanup();
});

test("知识库 MCP sidecar：拉起 → initialize → tools/list → 检索命中 → 审计落盘", async () => {
  const { page, dataRoot } = launched;

  // 先经真实 IPC 导入一份文档，让索引库里有东西可查
  const docsDir = join(dataRoot, "mcp-docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(
    join(docsDir, "retrieval.md"),
    `# 检索设计\n\n${"知识库采用 FTS5 与向量双路召回，再用 RRF 融合排序。".repeat(20)}\n`,
    "utf8",
  );

  const report = await page.evaluate(async (dir: string) => {
    // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
    const invoke = (channel: string, req?: unknown) => (window as any).ffpane.invoke(channel, req);
    return invoke("knowledge:import", { importId: "e2e-mcp", paths: [dir], tags: ["mcp"] });
  }, docsDir);
  expect((report as { chunks: number }).chunks).toBeGreaterThan(0);

  const auditPath = join(dataRoot, "mcp-audit.jsonl");
  const responses = await speakMcp(
    {
      FF_PANE_KNOWLEDGE_DB: join(dataRoot, "index.sqlite"),
      FF_PANE_KNOWLEDGE_AUDIT: auditPath,
    },
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "knowledge_search", arguments: { query: "RRF 融合", limit: 5 } },
      },
    ],
  );

  // 通知不回包，故恰好三条响应
  expect(responses).toHaveLength(3);

  const init = responses[0] as { result: { protocolVersion: string; serverInfo: unknown } };
  expect(init.result.protocolVersion).toBe("2025-06-18");
  expect(init.result.serverInfo).toBeDefined();

  // 工具面只有一个只读检索工具（写操作物理不存在，§8.3.5）
  const list = responses[1] as { result: { tools: { name: string }[] } };
  expect(list.result.tools).toHaveLength(1);
  expect(list.result.tools[0]?.name).toBe("knowledge_search");

  // 真检索到内容，且带出处行
  const call = responses[2] as { result: { isError?: boolean; content: { text: string }[] } };
  expect(call.result.isError).toBeUndefined();
  const text = call.result.content[0]?.text ?? "";
  expect(text).toContain("match(es)");
  expect(text).toContain("Source:");
  expect(text).toContain("retrieval.md");
  // 未配嵌入模型 → 如实告知只走了关键词路
  expect(text).toContain("keyword only");

  // 审计逐行落盘，供 Run 回读
  const audit = readFileSync(auditPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { query: string; hits: unknown[]; usedVector: boolean });
  expect(audit).toHaveLength(1);
  expect(audit[0]?.query).toBe("RRF 融合");
  expect(audit[0]?.hits.length).toBeGreaterThan(0);
  expect(audit[0]?.usedVector).toBe(false);
});
