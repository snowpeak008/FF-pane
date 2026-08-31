/**
 * 知识库页的纯视图逻辑（T6.5）：出处格式化、引用文本生成、过滤项派生、条目筛选。
 *
 * 放在单独文件里是为了能在 node 环境下直接单测——这些是最容易出错也最值得钉住的部分
 *（引用文本会被原样发进 Agent 的上下文，格式错了是用户看得见的事故）。
 *
 * **文案一律由调用方注入**：本模块不 import i18n，也不含任何面向用户的中文
 *（renderer 禁硬编码 CJK，check-i18n 把关）。分隔符、括号这类纯排版符号除外。
 */

import type { KnowledgeEntry, KnowledgeFormat } from "@ff-pane/shared";
import type { KnowledgeEntryView, KnowledgeHitView } from "../../../../shared-ipc/contracts";

/** 出处各级之间的分隔符（标题路径、页码、文件路径共用）。 */
export const PROVENANCE_SEPARATOR = " › ";

/** 取路径的文件名部分（出处首选展示项：完整路径太长，鼠标悬停再给全量）。 */
export function fileNameOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}

/** 取路径的目录部分（来源目录过滤的候选项）。正斜杠归一，与索引层口径一致。 */
export function directoryOf(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const cut = normalized.lastIndexOf("/");
  return cut <= 0 ? normalized : normalized.slice(0, cut);
}

/**
 * 出处轨迹：`文件名 › 标题 › 子标题 › 第 3 页`。
 * 页码文案由调用方给（`pageLabel`），缺省即不显示页码那一级。
 */
export function formatProvenanceTrail(
  hit: KnowledgeHitView,
  pageLabel?: string,
): readonly string[] {
  const trail: string[] = [fileNameOf(hit.chunk.provenance.filePath)];
  for (const heading of hit.chunk.provenance.headingPath ?? []) {
    trail.push(heading);
  }
  if (hit.chunk.provenance.page !== undefined && pageLabel !== undefined) {
    trail.push(pageLabel);
  }
  return trail;
}

/** 生成引用文本所需的文案（由调用方从语言包取）。 */
export interface CitationLabels {
  /** 出处行的前缀，如"来源："。 */
  readonly sourceLabel: string;
  /** 已格式化的页码文案，如"第 3 页"；无页码时省略。 */
  readonly pageLabel?: string;
}

/**
 * 命中 → 可直接发进会话的引用文本（§8.3.5「自动附带出处引用」）。
 *
 * 形态：块正文按 Markdown 引用块缩进，出处单独一行跟在后面。
 * **不把上下文扩展的相邻块一起塞进去**——扩展是给人看的阅读辅助，
 * 而发进会话的每个字都要占 Agent 的上下文预算；用户选中的是哪一块就发哪一块。
 */
export function buildKnowledgeCitation(hit: KnowledgeHitView, labels: CitationLabels): string {
  const quoted = hit.chunk.text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
  const trail = [
    hit.entryTitle,
    ...formatProvenanceTrail(hit, labels.pageLabel).slice(1),
    hit.chunk.provenance.filePath,
  ].join(PROVENANCE_SEPARATOR);
  return `${quoted}\n\n${labels.sourceLabel}${trail}`;
}

/** 多条命中 → 一段引用（条目之间空行分隔，顺序即用户勾选顺序）。 */
export function buildKnowledgeCitations(
  hits: readonly KnowledgeHitView[],
  labels: CitationLabels | ((hit: KnowledgeHitView) => CitationLabels),
): string {
  return hits
    .map((hit) => buildKnowledgeCitation(hit, typeof labels === "function" ? labels(hit) : labels))
    .join("\n\n");
}

/** 来源管理页可选的过滤项（从当前条目集合派生，不另存一份）。 */
export interface KnowledgeFilterOptions {
  readonly formats: readonly KnowledgeFormat[];
  readonly tags: readonly string[];
  /** 出现过的来源目录（升序，供"来源目录"过滤下拉）。 */
  readonly directories: readonly string[];
}

/**
 * 从条目集合派生可选过滤项。
 * 派生而不是另存：过滤项与库里实际有什么必须永远一致，
 * 单独维护一份「已知标签表」只会多出一处会过期的状态。
 */
export function deriveFilterOptions(
  entries: readonly KnowledgeEntryView[],
): KnowledgeFilterOptions {
  const formats = new Set<KnowledgeFormat>();
  const tags = new Set<string>();
  const directories = new Set<string>();
  for (const view of entries) {
    formats.add(view.entry.format);
    for (const tag of view.entry.tags ?? []) {
      tags.add(tag);
    }
    if (view.entry.origin.kind === "file_import") {
      directories.add(directoryOf(view.entry.origin.sourcePath));
    }
  }
  return {
    formats: [...formats].sort(),
    tags: [...tags].sort(),
    directories: [...directories].sort(),
  };
}

/** 条目的来源路径（非 file_import 无原文件，返回 undefined）。 */
export function sourcePathOf(entry: KnowledgeEntry): string | undefined {
  return entry.origin.kind === "file_import" ? entry.origin.sourcePath : undefined;
}

/** 来源管理页的本地筛选（标题 / 来源路径 / 标签，大小写不敏感）。 */
export function matchesEntrySearch(view: KnowledgeEntryView, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return true;
  }
  const haystack = [
    view.entry.title,
    sourcePathOf(view.entry) ?? "",
    ...(view.entry.tags ?? []),
  ].join(" ");
  return haystack.toLowerCase().includes(needle);
}

/** 条目的索引状态（§8.3.6「索引状态」一列）。 */
export type KnowledgeIndexState = "keyword-only" | "partial" | "indexed" | "empty";

/**
 * 判定一个条目的索引状态。
 *
 * `keyword-only` 是**正常状态而不是缺陷**（§8.3.3：没配嵌入模型时纯 FTS 功能完整），
 * 故它与 `partial`（配了嵌入模型但这条还没算完）分成两个态——前者不该提示用户去修。
 */
export function entryIndexState(
  view: KnowledgeEntryView,
  vectorEnabled: boolean,
): KnowledgeIndexState {
  if (view.chunkCount === 0) {
    return "empty";
  }
  if (!vectorEnabled) {
    return "keyword-only";
  }
  return view.embeddedCount >= view.chunkCount ? "indexed" : "partial";
}

/** 进度百分比（0~100 整数）；总数未知（0）时返回 undefined，交给不确定态进度条。 */
export function progressPercent(done: number, total: number): number | undefined {
  if (total <= 0) {
    return undefined;
  }
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}
