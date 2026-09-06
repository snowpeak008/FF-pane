/**
 * 工作台自配置工具的逐轮装配与审计回读（T9.1，Phase 9；照 T6.6 knowledge-tool.ts 款式）。
 *
 * 两件事：
 * 1. **装配**：把「内置 config sidecar + 本轮信箱目录 + providers/profiles 只读路径 +
 *    审计文件」编译成一个 {@link McpStdioServerSpec}，交给适配器按各自 Runtime 注入。
 * 2. **回读**：轮次收尾时把审计 JSONL 读回来落进 Run（list 行由 sidecar 追加、
 *    草案行由主进程 config-draft-hub 追加，见 mcp/config-server.ts 模块头的分工）。
 *
 * 与知识库工具的三点差异（各有理由，不是漏抄）：
 * - **无用户覆盖项（command/args/env）**：知识库工具允许用户换成自己的检索服务端；
 *   自配置工具的服务端职责是「把草案投进主进程的信箱」，换实现毫无意义，反而多出
 *   一个能把草案投去别处的口子。故恒用内置 sidecar。
 * - **信箱在全局数据根下而非系统临时目录**：信箱是双向通道（请求 + 响应 + 审计），
 *   排障时要能找到；数据根就是它的归属（`<root>/config-mailbox/turn-*`），
 *   轮次收尾由 hub 连目录一起清理。
 * - **确认超时是本模块的口径事实**：{@link CONFIG_CONFIRM_TIMEOUT_MS} = 5 分钟，
 *   sidecar 侧的兜底等待（RESPONSE_DEADLINE_MS = 330s）刻意略长于它——主进程超时会
 *   写 timeout 响应，sidecar 要等得到；sidecar 自己的兜底只防主进程整个消失。
 */

import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import type { McpStdioServerSpec } from "@ff-pane/adapters";
import type { ConfigToolCallRecord } from "@ff-pane/shared";
import { CONFIG_TOOL_NAMES, isConfigToolOutcome } from "@ff-pane/shared";

/** 内置 config sidecar 的产物文件名（与 electron.vite.config.ts 的 main 入口名一致）。 */
export const CONFIG_MCP_SCRIPT = "config-mcp.js";

/** sidecar 读取信箱根目录的环境变量名（与 src/mcp/config-server.ts 对齐）。 */
export const ENV_CONFIG_MAILBOX = "FF_PANE_CONFIG_MAILBOX";

/** sidecar 只读 providers.json 的环境变量名。 */
export const ENV_CONFIG_PROVIDERS = "FF_PANE_CONFIG_PROVIDERS";

/** sidecar 只读 profiles.json 的环境变量名。 */
export const ENV_CONFIG_PROFILES = "FF_PANE_CONFIG_PROFILES";

/** sidecar 写 list 调用审计的环境变量名。 */
export const ENV_CONFIG_AUDIT = "FF_PANE_CONFIG_AUDIT";

/** 信箱根目录名（全局数据根之下）。 */
export const CONFIG_MAILBOX_ROOT_NAME = "config-mailbox";

/** 每轮信箱目录前缀。 */
export const CONFIG_MAILBOX_DIR_PREFIX = "turn-";

/** 审计文件名（信箱目录内；sidecar 与主进程各自追加，JSONL）。 */
export const CONFIG_AUDIT_FILE_NAME = "audit.jsonl";

/**
 * 用户确认超时（毫秒）：草案呈现给用户后 5 分钟无裁决即按 timeout 收场（口径落档：
 * 计时起点是主进程从信箱捡起草案并推给渲染层的那一刻，不含校验耗时——校验失败根本
 * 不会进入等待）。超时不落盘、原样告知 Agent「未获裁决」，Agent 可提示用户后重试。
 */
export const CONFIG_CONFIRM_TIMEOUT_MS = 300_000;

/** 一轮信箱的路径集合。 */
export interface ConfigMailboxPaths {
  /** 信箱根（注入给 sidecar 的 ENV_CONFIG_MAILBOX）。 */
  readonly mailboxDir: string;
  /** sidecar 投递草案的目录。 */
  readonly requestsDir: string;
  /** 主进程写裁决结果的目录。 */
  readonly responsesDir: string;
  /** 审计 JSONL 路径。 */
  readonly auditPath: string;
}

/** 建一轮专用的信箱目录（请求 / 响应两个子目录 + 审计路径；目录随机不互相串写）。 */
export async function createConfigMailbox(mailboxRootDir: string): Promise<ConfigMailboxPaths> {
  await mkdir(mailboxRootDir, { recursive: true });
  const mailboxDir = await mkdtemp(join(mailboxRootDir, CONFIG_MAILBOX_DIR_PREFIX));
  const requestsDir = join(mailboxDir, "requests");
  const responsesDir = join(mailboxDir, "responses");
  await mkdir(requestsDir, { recursive: true });
  await mkdir(responsesDir, { recursive: true });
  return {
    mailboxDir,
    requestsDir,
    responsesDir,
    auditPath: join(mailboxDir, CONFIG_AUDIT_FILE_NAME),
  };
}

/** 装配输入。 */
export interface ResolveConfigMcpInput {
  /** 主进程模块所在目录（sidecar 与 main/index.js 同目录）。 */
  readonly moduleDir: string;
  /** 本轮信箱路径集合。 */
  readonly mailbox: ConfigMailboxPaths;
  /** providers.json 绝对路径（sidecar 只读，list 工具的数据源）。 */
  readonly providersFile: string;
  /** profiles.json 绝对路径（同上）。 */
  readonly profilesFile: string;
}

/**
 * 装配本轮的 config MCP 服务端规格。启动方式与知识库 sidecar 同款：
 * Electron 自身以 ELECTRON_RUN_AS_NODE 跑内置脚本，用户机器无需装 node。
 * 四个工具全部预放行：list 只读无副作用；draft 的「副作用」被确认对话框物理拦住
 * （草案不经用户确认不落盘），在 Agent 侧再弹一层审批只会让用户确认两遍同一件事。
 */
export function resolveConfigMcpServer(input: ResolveConfigMcpInput): McpStdioServerSpec {
  return {
    command: process.execPath,
    args: [join(input.moduleDir, CONFIG_MCP_SCRIPT)],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      [ENV_CONFIG_MAILBOX]: input.mailbox.mailboxDir,
      [ENV_CONFIG_PROVIDERS]: input.providersFile,
      [ENV_CONFIG_PROFILES]: input.profilesFile,
      [ENV_CONFIG_AUDIT]: input.mailbox.auditPath,
    },
    allowedTools: [...CONFIG_TOOL_NAMES],
  };
}

/** 一条审计行是否长得像 ConfigToolCallRecord（只校验后续消费真正依赖的字段）。 */
function isCallRecord(value: unknown): value is ConfigToolCallRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["tool"] === "string" &&
    typeof record["calledAt"] === "number" &&
    typeof record["summary"] === "string" &&
    isConfigToolOutcome(record["outcome"]) &&
    typeof record["durationMs"] === "number"
  );
}

/**
 * 读回本轮审计（容错口径照 readKnowledgeAudit：缺文件 = 一次没调用 → 空数组；
 * 坏行跳过；读取失败归空）。两个进程各自追加的行按 calledAt 升序归并——
 * Run.configToolCalls 的合同是「按时间升序」，而两个写者的落笔顺序不保证时序。
 */
export async function readConfigAudit(auditPath: string): Promise<readonly ConfigToolCallRecord[]> {
  let text: string;
  try {
    text = await readFile(auditPath, "utf8");
  } catch {
    return [];
  }
  const records: ConfigToolCallRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isCallRecord(parsed)) {
        records.push(parsed);
      }
    } catch {
      // 半行 JSON（写者被杀）：跳过，正是选 JSONL 的原因
    }
  }
  return records.toSorted((a, b) => a.calledAt - b.calledAt);
}
