/**
 * 工作台自配置工具 MCP 服务端入口（T9.1，Phase 9）。
 *
 * 与知识库 sidecar（server.ts）同款进程模型：由 CLI Agent 自己拉起、跑在独立进程里，
 * 与主进程之间不建任何网络连接（stdio 之外零端口、零流量，理由见 protocol.ts 头注）。
 *
 * 与主进程的通信是**文件信箱**（每轮一个临时目录，主进程注入路径）：
 * - 草案：本进程把工具原始入参原子写进 `requests/<id>.json`，然后轮询
 *   `responses/<id>.json` 直到主进程给出去向（confirmed / rejected / timeout / invalid）。
 * - 为什么不是 TCP/HTTP：同知识库 sidecar 的论证——引传输就要引端口与鉴权，且会被
 *   VPN / 代理规则波及；而知识库审计文件已经证明「文件」是这两个进程间可靠的通道，
 *   信箱只是把单向审计加了一个回向。轮询间隔 250ms，对「等用户点确认」的时间尺度而言
 *   毫无感知。
 *
 * 职责边界（两条铁律的进程分工）：
 * - 本进程对草案**不解析、不校验、不落盘**——解析与校验的权威在主进程
 *   （mcp/config-tool.ts 的解析器 + core/storage 的既有领域校验），落盘只发生在
 *   用户确认之后、经主进程的既有 store。本进程只是投递员。
 * - 只读工具（list）直接读 providers.json / profiles.json（只读），经
 *   sanitizeProvider 折算脱敏视图——**密钥引用与本体在输出里物理不存在**。
 * - 审计分工：list 调用的审计行由本进程追加；草案调用的审计行由主进程追加
 *   （去向与耗时的权威在主进程，含"轮次结束自动拒绝"这类本进程已死时的收尾）。
 *
 * 进程生命周期由 CLI 管：stdin 关闭即退出（等待中的草案由主进程按轮次收尾自动拒绝）。
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ConfigToolCallRecord, ProjectConfig, Provider } from "@ff-pane/shared";
import {
  CONFIG_TOOL_DRAFT_CONFIG,
  CONFIG_TOOL_DRAFT_PROVIDER,
  CONFIG_TOOL_LIST_CONFIGS,
  CONFIG_TOOL_LIST_PROVIDERS,
  DEFAULT_CONFIG_TOOL_SERVER_NAME,
} from "@ff-pane/shared";
import {
  CONFIG_TOOLS,
  type ConfigDraftRequestFile,
  type ConfigDraftResponseFile,
  renderConfigList,
  renderDraftOutcome,
  renderProviderList,
} from "./config-tool";
import { handleMcpLine, type McpServerOptions, type McpToolResult } from "./protocol";

/** 信箱根目录（主进程注入；requests/ 与 responses/ 两个子目录）。 */
const ENV_MAILBOX = "FF_PANE_CONFIG_MAILBOX";
/** providers.json 路径（只读；缺席时 list 返回空集）。 */
const ENV_PROVIDERS = "FF_PANE_CONFIG_PROVIDERS";
/** configs.json 路径（只读）。 */
const ENV_CONFIGS = "FF_PANE_CONFIG_CONFIGS";
/** 审计 JSONL 路径（本进程只写 list 调用的行；缺席即不留审计，照 knowledge sidecar 口径）。 */
const ENV_AUDIT = "FF_PANE_CONFIG_AUDIT";

/** 服务端自报版本（协议实现的版本，与应用版本解耦）。 */
const SERVER_VERSION = "1.0.0";

/** 响应轮询间隔。 */
const RESPONSE_POLL_MS = 250;

/**
 * 等待主进程回应的上限：略长于主进程的确认超时（5 分钟，见 main/session/config-tool.ts
 * CONFIG_CONFIRM_TIMEOUT_MS）——主进程超时会写 timeout 响应，本进程要等得到它；
 * 这里的兜底只防主进程整个消失（届时给模型一个明确的失败而不是永久挂起）。
 */
const RESPONSE_DEADLINE_MS = 330_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 审计追加（同步写、失败只警告——照知识库 sidecar 的同款论证）。 */
function appendAudit(auditPath: string | undefined, record: ConfigToolCallRecord): void {
  if (auditPath === undefined) {
    return;
  }
  try {
    appendFileSync(auditPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (thrown) {
    process.stderr.write(`[config-mcp] audit write failed: ${String(thrown)}\n`);
  }
}

/** 读整文件 JSON 里的条目数组；文件缺席 / 结构不符一律按空集（list 是常态查询，不该崩）。 */
function readEntries<T>(filePath: string | undefined, key: string): readonly T[] {
  if (filePath === undefined || filePath.length === 0) {
    return [];
  }
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) {
      return [];
    }
    const entries = (parsed as Record<string, unknown>)[key];
    return Array.isArray(entries) ? (entries as readonly T[]) : [];
  } catch {
    return [];
  }
}

/** 原子写请求文件（tmp + rename，主进程绝不会读到半个 JSON）。 */
function writeRequestAtomic(requestsDir: string, request: ConfigDraftRequestFile): void {
  const finalPath = join(requestsDir, `${request.id}.json`);
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(request), "utf8");
  renameSync(tmpPath, finalPath);
}

/** 轮询响应文件直到出现或超时（超时返回 undefined，由调用方给模型明确失败）。 */
async function awaitResponse(
  responsesDir: string,
  id: string,
): Promise<ConfigDraftResponseFile | undefined> {
  const path = join(responsesDir, `${id}.json`);
  const deadline = Date.now() + RESPONSE_DEADLINE_MS;
  while (Date.now() < deadline) {
    let text: string | undefined;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      text = undefined;
    }
    if (text !== undefined) {
      try {
        return JSON.parse(text) as ConfigDraftResponseFile;
      } catch {
        // 主进程也是原子写，读到半个 JSON 只可能是极端竞态：下一轮再读
      }
    }
    await sleep(RESPONSE_POLL_MS);
  }
  return undefined;
}

function main(): void {
  const mailboxDir = process.env[ENV_MAILBOX];
  if (mailboxDir === undefined || mailboxDir.length === 0) {
    process.stderr.write(`[config-mcp] missing ${ENV_MAILBOX}\n`);
    process.exit(1);
  }
  const providersFile = process.env[ENV_PROVIDERS];
  const configsFile = process.env[ENV_CONFIGS];
  const auditPath = process.env[ENV_AUDIT];
  const requestsDir = join(mailboxDir, "requests");
  const responsesDir = join(mailboxDir, "responses");
  mkdirSync(requestsDir, { recursive: true });
  mkdirSync(responsesDir, { recursive: true });

  const execute = async (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<McpToolResult> => {
    const startedAt = Date.now();

    if (name === CONFIG_TOOL_LIST_PROVIDERS) {
      const providers = readEntries<Provider>(providersFile, "providers");
      appendAudit(auditPath, {
        calledAt: startedAt,
        tool: name,
        summary: `list providers (${providers.length})`,
        outcome: "ok",
        durationMs: Date.now() - startedAt,
      });
      return { text: renderProviderList(providers) };
    }

    if (name === CONFIG_TOOL_LIST_CONFIGS) {
      const configs = readEntries<ProjectConfig>(configsFile, "configs");
      appendAudit(auditPath, {
        calledAt: startedAt,
        tool: name,
        summary: `list configs (${configs.length})`,
        outcome: "ok",
        durationMs: Date.now() - startedAt,
      });
      return { text: renderConfigList(configs) };
    }

    if (name === CONFIG_TOOL_DRAFT_PROVIDER || name === CONFIG_TOOL_DRAFT_CONFIG) {
      // 草案：原样投递，主进程是解析 / 校验 / 确认 / 审计的唯一权威（见模块头）
      const request: ConfigDraftRequestFile = {
        id: randomUUID(),
        tool: name,
        args,
        at: startedAt,
      };
      try {
        writeRequestAtomic(requestsDir, request);
      } catch (thrown) {
        return {
          text: `Could not submit the draft to the workbench: ${String(thrown)}`,
          isError: true,
        };
      }
      const response = await awaitResponse(responsesDir, request.id);
      if (response === undefined) {
        return {
          text: "The workbench did not answer the draft request in time. Nothing was saved.",
          isError: true,
        };
      }
      return {
        text: renderDraftOutcome(response),
        ...(response.outcome === "invalid" || response.outcome === "error"
          ? { isError: true }
          : {}),
      };
    }

    return { text: `Unknown tool: ${name}`, isError: true };
  };

  const options: McpServerOptions = {
    name: DEFAULT_CONFIG_TOOL_SERVER_NAME,
    version: SERVER_VERSION,
    tools: CONFIG_TOOLS,
    execute,
  };

  const rl = createInterface({ input: process.stdin });
  // 串行处理（照知识库 sidecar）：草案本就要逐个经用户裁决，排队让确认对话框一次一件
  let queue: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    queue = queue.then(async () => {
      const response = await handleMcpLine(line, options);
      if (response !== null) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    });
  });
  rl.on("close", () => {
    void queue.finally(() => {
      process.exit(0);
    });
  });
}

main();
