/**
 * 只读知识库检索工具的声明、入参解析与结果渲染（T6.6，设计文档 §8.3.5 路径二）。
 *
 * **工具面只有这一个，且只读**：没有 add / update / delete / reindex 工具，
 * 「Agent 永远不能写入、修改、删除知识库」因此不是一条需要被检查的规则，
 * 而是服务端根本没有这些方法——写操作物理不存在，也就没有绕过的可能。
 *
 * 纯模块：不碰 SQLite、不发请求，检索结果由宿主传进来渲染。故渲染规则可快照单测。
 */

import type { KnowledgeEntry, KnowledgeFormat, KnowledgeQueryHit } from "@ff-pane/shared";
import { KNOWLEDGE_FORMATS, KNOWLEDGE_TOOL_NAME } from "@ff-pane/shared";
import type { KnowledgeSearchHit } from "@ff-pane/storage";
import type { McpToolDefinition } from "./protocol";

/** 缺省返回条数。 */
export const DEFAULT_TOOL_LIMIT = 8;

/** 返回条数上限：Agent 的上下文预算有限，给再多也是浪费且会挤掉正事。 */
export const MAX_TOOL_LIMIT = 20;

/** 进 Run 审计的块正文截断长度（审计要看得懂命中了什么，不需要全文）。 */
export const SNIPPET_MAX_CHARS = 240;

/**
 * 工具声明。
 *
 * 过滤维度刻意只放 formats / tags / sourcePathPrefix 三项，**不放导入时间区间**：
 * §8.3.4 的四维过滤是给知识库页的人用的（人知道自己上周导了什么），而 Agent 对
 * 「导入时间」没有任何判断依据，多一个它填不对的参数只会诱发无意义的过滤。
 * 真要按时间筛，那是用户在界面上做的事。
 */
export const KNOWLEDGE_SEARCH_TOOL: McpToolDefinition = {
  name: KNOWLEDGE_TOOL_NAME,
  description:
    "Search the user's local knowledge base and return matching text chunks with their provenance " +
    "(file path, heading path, page number). Read-only: this tool cannot add, modify or delete " +
    "anything. Use it when the user's question likely depends on their imported documents.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language query or keywords to search for.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_TOOL_LIMIT,
        description: `Maximum number of chunks to return (default ${DEFAULT_TOOL_LIMIT}).`,
      },
      formats: {
        type: "array",
        items: { type: "string", enum: [...KNOWLEDGE_FORMATS] },
        description: "Restrict results to these document formats.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Restrict results to entries carrying any of these tags.",
      },
      sourcePathPrefix: {
        type: "string",
        description: "Restrict results to entries imported from under this path prefix.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

/** 解析成功的入参。 */
export interface ParsedToolArgs {
  readonly query: string;
  readonly limit: number;
  readonly formats?: readonly KnowledgeFormat[];
  readonly tags?: readonly string[];
  readonly sourcePathPrefix?: string;
}

/** 入参解析结果：判别联合，逼调用方处理坏参数。 */
export type ParseToolArgsResult =
  | { readonly ok: true; readonly args: ParsedToolArgs }
  | { readonly ok: false; readonly error: string };

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return items.length > 0 ? items : undefined;
}

/**
 * 解析工具入参。
 *
 * 宽进但不猜：query 缺失或空白是硬错误（空查询检索不出任何东西，静默返回空结果
 * 会让模型以为知识库里没有相关内容，而事实是它自己没给查询词）；limit 越界夹到
 * 合法区间而不是报错（模型给 100 是想"多要点"，夹到上限即可，不必为此让一次调用失败）。
 */
export function parseToolArgs(args: Readonly<Record<string, unknown>>): ParseToolArgsResult {
  const rawQuery = args["query"];
  if (typeof rawQuery !== "string" || rawQuery.trim().length === 0) {
    return { ok: false, error: "参数 query 必填，且不能为空。" };
  }

  const rawLimit = args["limit"];
  let limit = DEFAULT_TOOL_LIMIT;
  if (typeof rawLimit === "number" && Number.isFinite(rawLimit)) {
    limit = Math.min(MAX_TOOL_LIMIT, Math.max(1, Math.floor(rawLimit)));
  }

  const formats = stringArray(args["formats"])?.filter((item): item is KnowledgeFormat =>
    (KNOWLEDGE_FORMATS as readonly string[]).includes(item),
  );
  const tags = stringArray(args["tags"]);
  const rawPrefix = args["sourcePathPrefix"];
  const sourcePathPrefix =
    typeof rawPrefix === "string" && rawPrefix.trim().length > 0 ? rawPrefix.trim() : undefined;

  return {
    ok: true,
    args: {
      query: rawQuery.trim(),
      limit,
      ...(formats !== undefined && formats.length > 0 ? { formats } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(sourcePathPrefix !== undefined ? { sourcePathPrefix } : {}),
    },
  };
}

/** 出处的一行表达：文件路径 + 标题路径 / 页码。 */
export function formatProvenance(hit: KnowledgeQueryHit): string {
  const parts: string[] = [hit.filePath];
  if (hit.headingPath !== undefined && hit.headingPath.length > 0) {
    parts.push(hit.headingPath.join(" › "));
  }
  if (hit.page !== undefined) {
    parts.push(`p.${hit.page}`);
  }
  return parts.join(" — ");
}

/** 截断到指定长度，截断处加省略号（不在码位中间切开代理对）。 */
function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

/**
 * 把检索命中折算成审计条目。
 *
 * 条目标题不在块上（块只带出处路径），故由宿主传入 entry 查表；查不到就退回文件路径，
 * 不让审计因为一条条目被并发删掉而整体失败。
 */
export function toQueryHits(
  hits: readonly KnowledgeSearchHit[],
  lookupEntry: (id: KnowledgeSearchHit["chunk"]["entryId"]) => KnowledgeEntry | undefined,
): readonly KnowledgeQueryHit[] {
  return hits.map((hit) => {
    const entry = lookupEntry(hit.chunk.entryId);
    const { provenance } = hit.chunk;
    return {
      entryId: hit.chunk.entryId,
      chunkId: hit.chunk.id,
      title: entry?.title ?? provenance.filePath,
      filePath: provenance.filePath,
      ...(provenance.headingPath !== undefined && provenance.headingPath.length > 0
        ? { headingPath: provenance.headingPath }
        : {}),
      ...(provenance.page !== undefined ? { page: provenance.page } : {}),
      score: hit.score,
      snippet: truncate(hit.chunk.text.trim(), SNIPPET_MAX_CHARS),
    };
  });
}

/** 渲染参数：命中 + 本次实际走了哪几路。 */
export interface RenderToolResultInput {
  readonly query: string;
  readonly hits: readonly KnowledgeQueryHit[];
  /** 命中块全文（与 hits 同序同长；审计存截断片段，回给模型的是全文）。 */
  readonly fullTexts: readonly string[];
  readonly usedFts: boolean;
  readonly usedVector: boolean;
}

/**
 * 渲染回给模型的文本。
 *
 * 三条取舍：
 * ① **给模型的是块全文、审计里存的是截断片段**——模型要靠正文回答问题，而审计只需
 *    看得出命中了什么。两者需求不同，不该为省事共用一份。
 * ② **如实说明本次走了哪几路**：纯关键词检索是一等状态而非缺陷（§8.3.3），但模型
 *    需要知道——若它以为刚做过语义检索却一无所获，就会错误地断定"知识库里没有"，
 *    而正确的下一步其实是换个关键词再搜一次。
 * ③ **零命中不是错误**：给一句明确的"没搜到"，而不是 isError。搜不到是有效答案。
 */
export function renderToolResult(input: RenderToolResultInput): string {
  const mode = input.usedVector
    ? "keyword + semantic"
    : input.usedFts
      ? "keyword only (full-text index; semantic search is not enabled for the agent tool)"
      : "keyword only (substring fallback; the query was too short for the full-text index)";

  if (input.hits.length === 0) {
    return `No matches for "${input.query}" in the knowledge base. Retrieval mode: ${mode}.`;
  }

  const blocks = input.hits.map((hit, index) => {
    const text = input.fullTexts[index] ?? hit.snippet;
    return [
      `## [${index + 1}] ${hit.title}`,
      `Source: ${formatProvenance(hit)}`,
      "",
      text.trim(),
    ].join("\n");
  });

  return [
    `${input.hits.length} match(es) for "${input.query}". Retrieval mode: ${mode}.`,
    "Cite the source line when you use one of these chunks.",
    "",
    blocks.join("\n\n---\n\n"),
  ].join("\n");
}
