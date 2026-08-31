/**
 * 知识库只读检索 MCP 服务端入口（T6.6，设计文档 §8.3.5 路径二）。
 *
 * 由 **CLI Agent 自己拉起**（codex 经 `-c mcp_servers.*`、claude 经 `--mcp-config`），
 * 不是主进程的子进程。故本文件跑在一个独立进程里，与主进程之间**没有任何连接**——
 * 它直接以只读方式打开同一个 index.sqlite 查数据，用一个 JSONL 文件留审计。
 *
 * 为什么不与主进程通信：
 * - 一旦要通信就要选传输。TCP/HTTP 会引入端口、监听地址与鉴权，且会被系统代理与 VPN
 *   规则波及——那正是本设计要避免的（用户明确要求"只在内部流通、不影响 VPN 与正常网络"）。
 * - 索引本身就是一个可被多连接打开的 SQLite 文件，直接只读打开是最短路径，零协议、零端口。
 *
 * **不做向量检索，只走关键词路**，这是一个刻意的安全取舍而非未完成项：
 * 语义检索要对查询串现场调用嵌入端点，就得把嵌入 Provider 的 API 密钥交到本进程手上。
 * 而本进程的启动参数与环境变量由 CLI 承载——codex 的 MCP env 会写进 `-c` 命令行参数
 * （在进程列表里肉眼可见），claude 的会落进 `--mcp-config` 临时 JSON 文件。两条都与
 * §4.3「密钥只经 env 下发给 Agent 进程本身、不落盘不进命令行」相抵触。§8.3.3 已确立
 * 「向量检索是增强而非前提」，纯 BM25 检索功能完整，故这里选择不要那把密钥。
 * 检索结果会如实告知模型本次只走了关键词路（见 knowledge-tool.renderToolResult）。
 *
 * 进程生命周期由 CLI 管：stdin 关闭即退出。
 */

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type {
  KnowledgeEntry,
  KnowledgeEntryId,
  KnowledgeQueryHit,
  KnowledgeQueryRecord,
} from "@ff-pane/shared";
import { KNOWLEDGE_TOOL_NAME } from "@ff-pane/shared";
import { closeIndexDb, getKnowledgeEntry, openIndexDb, searchKnowledge } from "@ff-pane/storage";
import {
  KNOWLEDGE_SEARCH_TOOL,
  parseToolArgs,
  renderToolResult,
  toQueryHits,
} from "./knowledge-tool";
import { handleMcpLine, type McpServerOptions, type McpToolResult } from "./protocol";

/** 索引库路径（主进程注入）。 */
const ENV_DB_PATH = "FF_PANE_KNOWLEDGE_DB";
/** 审计 JSONL 路径（主进程注入；缺席即不留审计，服务端照常可用）。 */
const ENV_AUDIT_PATH = "FF_PANE_KNOWLEDGE_AUDIT";

/** 上下文扩展块数：与知识库页一致（§8.3.4 前后各一块）。 */
const CONTEXT_RADIUS = 1;

/** 服务端自报版本（与产品版本解耦：协议实现的版本，不是应用版本）。 */
const SERVER_VERSION = "1.0.0";

/**
 * 追加一条审计。
 *
 * 同步写、失败只警告不中断：审计是旁路证据，写不进去（磁盘满、路径被删）不该让
 * Agent 的这次检索失败——那会把一个记账问题升级成一次任务失败。
 * 用 JSONL 而不是 JSON 数组：进程可能被 CLI 随时杀掉，逐行追加的文件在任何时刻
 * 都是可解析的（最多丢最后一行），而半个 JSON 数组整份都读不出来。
 */
function appendAudit(auditPath: string | undefined, record: KnowledgeQueryRecord): void {
  if (auditPath === undefined) {
    return;
  }
  try {
    appendFileSync(auditPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (thrown) {
    process.stderr.write(`[knowledge-mcp] audit write failed: ${String(thrown)}\n`);
  }
}

function main(): void {
  const dbPath = process.env[ENV_DB_PATH];
  const auditPath = process.env[ENV_AUDIT_PATH];
  if (dbPath === undefined || dbPath.length === 0) {
    process.stderr.write(`[knowledge-mcp] missing ${ENV_DB_PATH}\n`);
    process.exit(1);
  }

  let db: ReturnType<typeof openIndexDb>;
  try {
    db = openIndexDb({ filePath: dbPath, readonly: true });
  } catch (thrown) {
    // 库不存在 = 用户还没建过知识库。这是配置问题不是崩溃，给一句能看懂的话再退出。
    process.stderr.write(`[knowledge-mcp] cannot open knowledge index: ${String(thrown)}\n`);
    process.exit(1);
  }

  /** 条目标题查表缓存：一次检索通常只涉及十几个条目，逐条目查一次即可。 */
  const entryCache = new Map<KnowledgeEntryId, KnowledgeEntry | undefined>();
  const lookupEntry = (id: KnowledgeEntryId): KnowledgeEntry | undefined => {
    if (!entryCache.has(id)) {
      entryCache.set(id, getKnowledgeEntry(db, id));
    }
    return entryCache.get(id);
  };

  const execute = async (
    _name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<McpToolResult> => {
    const parsed = parseToolArgs(args);
    if (!parsed.ok) {
      return { text: parsed.error, isError: true };
    }
    const { query, limit, formats, tags, sourcePathPrefix } = parsed.args;
    const startedAt = Date.now();

    const filters = {
      ...(formats !== undefined ? { formats } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(sourcePathPrefix !== undefined ? { sourcePathPrefix } : {}),
    };

    try {
      // 无 queryVector / vectorIndex：向量路整条缺席，退化为纯 BM25（见模块注释）
      const result = searchKnowledge(db, {
        query,
        ...(Object.keys(filters).length > 0 ? { filters } : {}),
        limit,
        contextBefore: CONTEXT_RADIUS,
        contextAfter: CONTEXT_RADIUS,
      });
      const hits: readonly KnowledgeQueryHit[] = toQueryHits(result.hits, lookupEntry);
      appendAudit(auditPath, {
        calledAt: startedAt,
        query,
        ...(Object.keys(filters).length > 0 ? { filters } : {}),
        limit,
        hits,
        usedFts: result.usedFts,
        usedVector: result.usedVector,
        durationMs: Date.now() - startedAt,
      });
      return {
        text: renderToolResult({
          query,
          hits,
          fullTexts: result.hits.map((hit) => hit.chunk.text),
          usedFts: result.usedFts,
          usedVector: result.usedVector,
        }),
      };
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      // 失败的调用同样留档——排障时要的正是"它搜了什么、为什么没成"
      appendAudit(auditPath, {
        calledAt: startedAt,
        query,
        ...(Object.keys(filters).length > 0 ? { filters } : {}),
        limit,
        hits: [],
        usedFts: false,
        usedVector: false,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      return { text: `Knowledge search failed: ${message}`, isError: true };
    }
  };

  const options: McpServerOptions = {
    name: KNOWLEDGE_TOOL_NAME,
    version: SERVER_VERSION,
    tools: [KNOWLEDGE_SEARCH_TOOL],
    execute,
  };

  const rl = createInterface({ input: process.stdin });
  // 串行处理：MCP 允许并发请求，但本服务端是同步 SQLite 查询，排队反而最省心，
  // 也让审计文件的行序与调用序一致。
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
      closeIndexDb(db);
      process.exit(0);
    });
  });
}

main();
