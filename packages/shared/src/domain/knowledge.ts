/**
 * 知识库：第 3 层记忆，大规模文档 RAG 检索系统（设计文档 §8.3）。
 * 本文件只定条目、文本块、出处与检索结果形态；解析/分块/索引管道属 rag 包
 * （Phase 6），来源统计（文档数/块数/索引状态，§8.3.6）为查询层派生视图。
 */

import type { EpochMillis, KnowledgeChunkId, KnowledgeEntryId, LocalSessionId } from "./common.js";
import { createLiteralGuard } from "./common.js";

/**
 * 设计文档 §8.3.2 —— 支持格式：Markdown / txt / 源代码文件 / PDF / docx / html。
 * 按扩展名分发到对应解析器（技术选型 §8），source_code 涵盖各语言源码文件。
 */
export const KNOWLEDGE_FORMATS = [
  "markdown",
  "text",
  "source_code",
  "pdf",
  "docx",
  "html",
] as const;

/** 设计文档 §8.3.2 —— 知识库条目格式。 */
export type KnowledgeFormat = (typeof KNOWLEDGE_FORMATS)[number];

/** KnowledgeFormat 运行时守卫。 */
export const isKnowledgeFormat = createLiteralGuard(KNOWLEDGE_FORMATS);

/** 设计文档 §8.3.2 —— 三种导入方式类别。 */
export const KNOWLEDGE_ORIGIN_KINDS = ["file_import", "session_capture", "manual"] as const;

/** 设计文档 §8.3.2 —— 知识库条目来源类别。 */
export type KnowledgeOriginKind = (typeof KNOWLEDGE_ORIGIN_KINDS)[number];

/** KnowledgeOriginKind 运行时守卫。 */
export const isKnowledgeOriginKind = createLiteralGuard(KNOWLEDGE_ORIGIN_KINDS);

/**
 * 设计文档 §8.3.2 —— 条目来源：
 * file_import 单文件或文件夹批量导入（保留目录结构作为来源路径）；
 * session_capture 从会话收录（任意消息 →"存入知识库"）；
 * manual 手动新建条目。
 */
export type KnowledgeOrigin =
  | {
      readonly kind: "file_import";
      /** 设计文档 §8.3.2 —— 导入原文件路径（含导入时的目录结构）。 */
      readonly sourcePath: string;
    }
  | {
      readonly kind: "session_capture";
      /** 收录自哪个会话。 */
      readonly sessionId: LocalSessionId;
    }
  | { readonly kind: "manual" };

/**
 * 设计文档 §8.3 —— 知识库条目（文档级）。
 * 原文件是真实数据源（§8.4），索引均为派生数据，可随时重建。
 */
export interface KnowledgeEntry {
  /** 内部唯一 ID。 */
  readonly id: KnowledgeEntryId;
  /** 条目标题（文件名或用户命名）。 */
  readonly title: string;
  /** 设计文档 §8.3.2 —— 格式。 */
  readonly format: KnowledgeFormat;
  /** 设计文档 §8.3.2 —— 来源（导入方式与出处路径）。 */
  readonly origin: KnowledgeOrigin;
  /** 设计文档 §8.3.2 —— 内容哈希：增量索引按它判断变化，只重新索引变动文件。 */
  readonly contentHash: string;
  /** 设计文档 §8.3.4 —— 过滤维度之一：导入时间（epoch 毫秒）。 */
  readonly importedAt: EpochMillis;
  /** 设计文档 §8.3.4 —— 过滤维度之一：标签（可选）。 */
  readonly tags?: readonly string[];
}

/**
 * 设计文档 §8.3.4 —— 出处（文件路径 / 标题 / 页码）。
 * 由分块管道（T6.2）按格式填充：Markdown 记标题路径，PDF 记页码。
 */
export interface ChunkProvenance {
  /** 出处文件路径（manual/session_capture 条目为其存储文件路径，§10.1 notes/）。 */
  readonly filePath: string;
  /** Markdown 标题层级路径（如 ["安装", "Windows"]，非 Markdown 缺省）。 */
  readonly headingPath?: readonly string[];
  /** PDF 页码（从 1 起，非 PDF 缺省）。 */
  readonly page?: number;
}

/**
 * 设计文档 §8.3.3 —— 文本块（分块产物，300~800 token 带重叠）。
 * FTS5 与向量双路索引均建立在块之上；块本身随索引可重建，非真实数据源。
 */
export interface KnowledgeChunk {
  /** 内部唯一 ID。 */
  readonly id: KnowledgeChunkId;
  /** 所属条目。 */
  readonly entryId: KnowledgeEntryId;
  /** 块在条目内的序号（从 0 起；上下文扩展按相邻序号取块，§8.3.4）。 */
  readonly seq: number;
  /** 块正文。 */
  readonly text: string;
  /** 设计文档 §8.3.4 —— 出处。 */
  readonly provenance: ChunkProvenance;
}

/**
 * 设计文档 §8.3.4 —— 检索结果形态：命中块 + 上下文扩展（前后相邻块）+ 出处。
 * "发送到当前会话"自动附带出处引用（§8.3.5）即取 chunk.provenance。
 */
export interface KnowledgeHit {
  /** 命中块。 */
  readonly chunk: KnowledgeChunk;
  /** 融合排序分（FTS5 BM25 与向量相似度双路召回 → RRF 融合，值大者靠前）。 */
  readonly score: number;
  /** 上下文扩展：命中块之前的相邻块。 */
  readonly before: readonly KnowledgeChunk[];
  /** 上下文扩展：命中块之后的相邻块。 */
  readonly after: readonly KnowledgeChunk[];
}
