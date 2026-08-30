/**
 * 分块入口（T6.2 主入口，设计文档 §8.3.3）。
 *
 * 消费 T6.1 的 ParsedDocument，产出 ChunkDraft[]：
 *   markdown    → 标题树分段
 *   source_code → 函数/类边界分段（启发式）
 *   pdf         → 按页 + 页内段落分段，块带页码
 *   text/html/docx → 按空行段落分段
 * 之后统一交给与格式无关的打包层。
 *
 * 纯函数：无 IO、无时钟、无随机——同样的文档恒得同样的块，快照测试与
 * 增量索引（按内容哈希判断是否需要重新索引，§8.3.2）都依赖这一点。
 */

import type { KnowledgeChunk, KnowledgeChunkId, KnowledgeEntryId } from "@ff-pane/shared";
import type { ParsedDocument, ParsedPage } from "../parse/types.js";
import { segmentCode } from "./code.js";
import { segmentMarkdown } from "./markdown.js";
import { packSegments } from "./pack.js";
import { splitParagraphs, splitPlainText } from "./plain.js";
import { estimateTokens } from "./tokens.js";
import {
  type ChunkDraft,
  type ChunkingParams,
  DEFAULT_CHUNKING_PARAMS,
  type Segment,
} from "./types.js";

/** chunkDocument 的入参。 */
export interface ChunkDocumentOptions {
  /**
   * 出处文件路径（→ ChunkProvenance.filePath）。
   * ParsedDocument 本身不带路径：解析产物是纯内容，路径属于收录侧的事实。
   */
  readonly filePath: string;
  /** 覆盖块下限（默认 300）。 */
  readonly minTokens?: number;
  /** 覆盖块上限（默认 800）。 */
  readonly maxTokens?: number;
  /** 覆盖重叠比例（默认 0.15）。 */
  readonly overlapRatio?: number;
}

/** 重叠比例上限：超过一半的重叠意味着同一段文字被索引两遍，得不偿失。 */
const MAX_OVERLAP_RATIO = 0.5;

/** 校验并补全分块参数。参数不自洽时立即抛 RangeError，不静默纠偏。 */
function resolveParams(options: ChunkDocumentOptions): ChunkingParams {
  const minTokens = options.minTokens ?? DEFAULT_CHUNKING_PARAMS.minTokens;
  const maxTokens = options.maxTokens ?? DEFAULT_CHUNKING_PARAMS.maxTokens;
  const overlapRatio = options.overlapRatio ?? DEFAULT_CHUNKING_PARAMS.overlapRatio;

  if (!Number.isInteger(minTokens) || minTokens < 1) {
    throw new RangeError(`chunkDocument: minTokens 必须是正整数，实际 ${minTokens}`);
  }
  if (!Number.isInteger(maxTokens) || maxTokens <= minTokens) {
    throw new RangeError(`chunkDocument: maxTokens 必须是大于 minTokens 的整数，实际 ${maxTokens}`);
  }
  if (!Number.isFinite(overlapRatio) || overlapRatio < 0 || overlapRatio >= MAX_OVERLAP_RATIO) {
    throw new RangeError(`chunkDocument: overlapRatio 必须落在 [0, 0.5)，实际 ${overlapRatio}`);
  }
  // 上限扣掉重叠预算后必须仍高于下限，否则「达下限」与「不超上限」互相矛盾
  const contentMax = maxTokens - Math.round(maxTokens * overlapRatio);
  if (contentMax <= minTokens) {
    throw new RangeError(
      `chunkDocument: 扣除重叠后的内容预算 ${contentMax} 不足以超过 minTokens ${minTokens}`,
    );
  }

  return { minTokens, maxTokens, overlapRatio };
}

/** PDF：按页分段，页内再按空行切段落，每段带页码。 */
function segmentPages(pages: readonly ParsedPage[]): readonly Segment[] {
  const segments: Segment[] = [];
  for (const page of pages) {
    // 空页（扫描件的插页、纯图片页）不产段，但页码不因此错位
    splitParagraphs(page.text).forEach((paragraph, index) => {
      segments.push({
        text: paragraph,
        tokens: estimateTokens(paragraph),
        // 每页首段是换页边界，页内其余段落可自由合并
        boundary: index === 0 ? "structure" : "paragraph",
        page: page.page,
      });
    });
  }
  return segments;
}

/** 按格式选分段策略。导出供分段行为单测直接断言。 */
export function segmentDocument(document: ParsedDocument): readonly Segment[] {
  switch (document.format) {
    case "markdown":
      return segmentMarkdown(document.text);

    case "source_code":
      return segmentCode(document.text);

    case "pdf":
      // pages 缺省属异常输入（T6.1 的 PDF 解析器恒填），退回段落分段而不是崩掉
      return document.pages === undefined
        ? splitPlainText(document.text)
        : segmentPages(document.pages);

    case "text":
    case "html":
    case "docx":
      return splitPlainText(document.text);

    default: {
      // 穷尽性检查：KnowledgeFormat 新增成员时此处编译失败，逼迫补分段策略
      const exhaustive: never = document.format;
      throw new Error(`未覆盖的知识库格式: ${String(exhaustive)}`);
    }
  }
}

/** 把解析产物切成块草稿。空文档（或只有空白）返回空数组，不造空块。 */
export function chunkDocument(
  document: ParsedDocument,
  options: ChunkDocumentOptions,
): readonly ChunkDraft[] {
  const params = resolveParams(options);
  return packSegments(segmentDocument(document), options.filePath, params);
}

/** 把块草稿落成领域实体所需的注入项（条目归属与 ID 生成）。 */
export interface KnowledgeChunkIdentity {
  /** 块所属的知识库条目。 */
  readonly entryId: KnowledgeEntryId;
  /** 生成块 ID（宿主注入，分块层不产生随机性）。 */
  readonly newId: (draft: ChunkDraft) => KnowledgeChunkId;
}

/** 块草稿 → KnowledgeChunk（收录流程在拿到条目 ID 之后调用）。 */
export function toKnowledgeChunks(
  drafts: readonly ChunkDraft[],
  identity: KnowledgeChunkIdentity,
): readonly KnowledgeChunk[] {
  return drafts.map((draft) => ({
    id: identity.newId(draft),
    entryId: identity.entryId,
    seq: draft.seq,
    text: draft.text,
    provenance: draft.provenance,
  }));
}
