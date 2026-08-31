/**
 * Agent 只读知识库检索工具的逐轮装配与审计回读（T6.6，设计文档 §8.3.5 路径二）。
 *
 * 两件事：
 * 1. **装配**：把「内置 sidecar + 本机索引库路径 + 本轮审计文件」编译成一个
 *    {@link McpStdioServerSpec}，交给适配器按各自 Runtime 的方式注入。
 * 2. **回读**：轮次结束后把 sidecar 写下的 JSONL 审计读回来，落进 Run 记录，
 *    使「Agent 每次调用了什么、命中了什么」在执行记录页可见。
 *
 * **为什么内置服务端是"用 Electron 自己以 node 模式跑一个脚本"**：产品已经带着一个
 * Node 运行时（Electron 二进制本身），再为 sidecar 附带一个 node.exe 是平白增加
 * 数十 MB 与一份需要各自升级的运行时。`ELECTRON_RUN_AS_NODE=1` 是 Electron 官方
 * 支持的用法，且它对 asar 内路径的支持照常有效（打包后脚本就在 app.asar 里）。
 * 因此不需要用户机器上装有 node——这对一个桌面产品是硬要求。
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { McpStdioServerSpec } from "@ff-pane/adapters";
import type { KnowledgeQueryRecord, KnowledgeToolSettings } from "@ff-pane/shared";
import { DEFAULT_KNOWLEDGE_TOOL_SERVER_NAME, KNOWLEDGE_TOOL_NAME } from "@ff-pane/shared";

/** 内置 sidecar 的产物文件名（与 electron.vite.config.ts 的 main 入口名一致）。 */
export const KNOWLEDGE_MCP_SCRIPT = "knowledge-mcp.js";

/** sidecar 读取索引库路径的环境变量名（与 src/mcp/server.ts 对齐）。 */
export const ENV_KNOWLEDGE_DB = "FF_PANE_KNOWLEDGE_DB";

/** sidecar 写审计的环境变量名（与 src/mcp/server.ts 对齐）。 */
export const ENV_KNOWLEDGE_AUDIT = "FF_PANE_KNOWLEDGE_AUDIT";

/** 本轮审计临时目录前缀。 */
export const KNOWLEDGE_AUDIT_DIR_PREFIX = "ff-pane-knowledge-audit-";

/** 审计文件名。 */
export const KNOWLEDGE_AUDIT_FILE_NAME = "queries.jsonl";

/** 装配输入。 */
export interface ResolveKnowledgeMcpInput {
  /** 主进程模块所在目录（sidecar 与 main/index.js 同目录）。 */
  readonly moduleDir: string;
  /** 索引库文件绝对路径（全局 §10.1）。 */
  readonly indexDbFile: string;
  /** 本轮审计文件绝对路径。 */
  readonly auditPath: string;
  /** 用户设置（全部字段可缺省 = 全用内置默认）。 */
  readonly settings?: KnowledgeToolSettings | undefined;
}

/** 装配结果：服务器注册名 + 规格。 */
export interface ResolvedKnowledgeMcp {
  readonly serverName: string;
  readonly spec: McpStdioServerSpec;
}

/**
 * 装配本轮的 MCP 服务端规格。
 *
 * 用户可覆盖 command/args/env（「地址可自己配置」在 stdio 语境下就是这三项，
 * 与被参考项目的 McpServerConfig 同形）。覆盖 command 时**不再注入
 * ELECTRON_RUN_AS_NODE**：那是内置 sidecar 的启动方式，用户指了别的可执行文件
 * （自研服务端、python、node）时硬塞这个变量只会让它困惑。
 * 索引库与审计两个路径始终注入——它们不是"配置"，而是本轮的事实。
 */
export function resolveKnowledgeMcpServer(input: ResolveKnowledgeMcpInput): ResolvedKnowledgeMcp {
  const { moduleDir, indexDbFile, auditPath, settings } = input;
  const useBuiltIn = settings?.command === undefined || settings.command.length === 0;

  const command = useBuiltIn ? process.execPath : (settings?.command as string);
  const args = useBuiltIn ? [join(moduleDir, KNOWLEDGE_MCP_SCRIPT)] : [...(settings?.args ?? [])];

  const env: Record<string, string> = {
    ...(useBuiltIn ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    [ENV_KNOWLEDGE_DB]: indexDbFile,
    [ENV_KNOWLEDGE_AUDIT]: auditPath,
    // 用户追加项放最后：允许覆盖上面的默认（如把审计导到别处），
    // 但不允许用它塞密钥——见 McpStdioServerSpec.env 的注释。
    ...(settings?.env ?? {}),
  };

  return {
    serverName: settings?.serverName ?? DEFAULT_KNOWLEDGE_TOOL_SERVER_NAME,
    spec: {
      command,
      args,
      env,
      // 只读检索无副作用，预先放行免掉每次调用一次审批弹窗
      allowedTools: [KNOWLEDGE_TOOL_NAME],
    },
  };
}

/** 建一个本轮专用的审计文件路径（目录随机，避免并发轮次互相串写）。 */
export async function createKnowledgeAuditPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), KNOWLEDGE_AUDIT_DIR_PREFIX));
  return join(dir, KNOWLEDGE_AUDIT_FILE_NAME);
}

/** 一条审计行是否长得像 KnowledgeQueryRecord（只校验后续消费真正依赖的字段）。 */
function isQueryRecord(value: unknown): value is KnowledgeQueryRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["query"] === "string" &&
    typeof record["calledAt"] === "number" &&
    Array.isArray(record["hits"])
  );
}

/**
 * 读回本轮审计。
 *
 * 三条容错，都是因为这份文件由另一个可能被随时杀掉的进程逐行追加：
 * - 文件不存在 = 本轮一次都没调用 → 空数组（**不是** undefined：调用方据此区分
 *   「开了工具但没用」与「没开工具」，见 Run.knowledgeQueries 的注释）；
 * - 最后一行可能写了一半 → 逐行解析，坏行跳过而不是整份作废；
 * - 读取失败 → 空数组。审计是旁路证据，读不出来不该让一轮已完成的任务落库失败。
 */
export async function readKnowledgeAudit(
  auditPath: string,
): Promise<readonly KnowledgeQueryRecord[]> {
  let text: string;
  try {
    text = await readFile(auditPath, "utf8");
  } catch {
    return [];
  }
  const records: KnowledgeQueryRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isQueryRecord(parsed)) {
        records.push(parsed);
      }
    } catch {
      // 半行 JSON：跳过（正是选 JSONL 而非 JSON 数组的原因）
    }
  }
  return records;
}
