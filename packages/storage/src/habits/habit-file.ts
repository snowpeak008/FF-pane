/**
 * HabitEntry 条目文件编解码（T5.1）：一条一文件（<id>.md），设计文档 §8.2。
 *
 * 文件格式 = 受控 frontmatter（复用 memory/frontmatter.ts 的类别无关子集）+ 正文：
 * - frontmatter 承载 id / category / status / source / enabled / importance /
 *   created / updated；习惯只有单一 content 字段（无 title/body 之分），故 content
 *   即正文全文（正文以单个换行收尾，解码时剥掉，保证逐字符往返）。
 * - created / updated 序列化为 ISO 8601 UTC 字符串（复用 memory 的 iso 助手）。
 * - source 序列化格式（本工单定义，持久层约定）：
 *   `user_manual` | `observed` | `distilled:<projectId>:<entryId>`。
 *   distilled 携带溯源（source_project + source_entry_id，§8.2.4）；ProjectId /
 *   MemoryEntryId 均无冒号，用冒号分隔无歧义。
 * - 读入容忍策略：未知 frontmatter key 忽略、不拒读；重写按规范形态重新生成。
 */

import type {
  HabitEntry,
  HabitEntryId,
  HabitSource,
  MemoryEntryId,
  ProjectId,
} from "@ff-pane/shared";
import {
  HABIT_CATEGORIES,
  isHabitCategory,
  isMemoryStatus,
  MEMORY_STATUSES,
} from "@ff-pane/shared";
// iso 时间戳助手是纯函数、类别无关，复用 memory 的实现（单一来源，避免重复）。
import { decodeIsoTimestamp, encodeIsoTimestamp } from "../memory/entry-file.js";
import type { FrontmatterValue } from "../memory/frontmatter.js";
import { encodeFrontmatterDocument, parseFrontmatterDocument } from "../memory/frontmatter.js";
import type { HabitEntryDecodeError, HabitResult } from "./errors.js";
import { HabitEntryFieldError, HabitFrontmatterError } from "./errors.js";

/** source 合法编码提示（错误信息与文档共用）。 */
export const HABIT_SOURCE_ENCODING_HINT =
  "user_manual | observed | distilled:<projectId>:<entryId>";

/** 序列化 HabitSource（格式见模块注释）。 */
export function encodeHabitSource(source: HabitSource): string {
  switch (source.kind) {
    case "user_manual":
      return "user_manual";
    case "observed":
      return "observed";
    case "distilled":
      return `distilled:${source.sourceProject}:${source.sourceEntryId}`;
  }
}

/** 反序列化 HabitSource；不合法返回 undefined（由调用方转成带字段的 typed error）。 */
export function decodeHabitSource(text: string): HabitSource | undefined {
  if (text === "user_manual") {
    return { kind: "user_manual" };
  }
  if (text === "observed") {
    return { kind: "observed" };
  }
  if (text.startsWith("distilled:")) {
    const rest = text.slice("distilled:".length);
    const sepIndex = rest.indexOf(":");
    if (sepIndex <= 0) {
      return undefined;
    }
    const sourceProject = rest.slice(0, sepIndex);
    const sourceEntryId = rest.slice(sepIndex + 1);
    if (sourceProject === "" || sourceEntryId === "") {
      return undefined;
    }
    return {
      kind: "distilled",
      sourceProject: sourceProject as ProjectId,
      sourceEntryId: sourceEntryId as MemoryEntryId,
    };
  }
  return undefined;
}

/** 编码正文（content 单字段）：非空 content 以单个换行收尾。 */
function encodeHabitBody(content: string): string {
  return content === "" ? "" : `${content}\n`;
}

/** 解码正文 → content：剥掉编码时加的单个尾随换行。 */
function decodeHabitBody(body: string): string {
  return body.endsWith("\n") ? body.slice(0, -1) : body;
}

/** 编码一条 HabitEntry 为条目文件全文。key 顺序固定，保证干净的 Git diff。 */
export function encodeHabitEntryFile(entry: HabitEntry): string {
  const frontmatter: Record<string, FrontmatterValue> = {
    id: entry.id,
    category: entry.category,
    status: entry.status,
    source: encodeHabitSource(entry.source),
    enabled: entry.enabled,
    importance: entry.importance,
    created: encodeIsoTimestamp(entry.createdAt),
    updated: encodeIsoTimestamp(entry.updatedAt),
  };
  return encodeFrontmatterDocument({ frontmatter, body: encodeHabitBody(entry.content) });
}

/** 解码条目文件全文。filePath 只用于错误上下文，不参与解码。 */
export function decodeHabitEntryFile(
  text: string,
  filePath: string,
): HabitResult<HabitEntry, HabitEntryDecodeError> {
  const parsed = parseFrontmatterDocument(text);
  if (!parsed.ok) {
    return {
      ok: false,
      error: new HabitFrontmatterError(filePath, parsed.issue.line, parsed.issue.reason),
    };
  }
  const fm = parsed.value.frontmatter;
  const invalid = (
    field: string,
    reason: string,
  ): HabitResult<HabitEntry, HabitEntryDecodeError> => ({
    ok: false,
    error: new HabitEntryFieldError(filePath, field, reason),
  });

  const rawId = fm["id"];
  if (rawId === undefined) {
    return invalid("id", "缺失必填字段");
  }
  if (typeof rawId !== "string" || rawId === "") {
    return invalid("id", "必须为非空字符串");
  }

  const rawCategory = fm["category"];
  if (rawCategory === undefined) {
    return invalid("category", "缺失必填字段");
  }
  if (!isHabitCategory(rawCategory)) {
    return invalid(
      "category",
      `非法枚举值「${String(rawCategory)}」，合法值: ${HABIT_CATEGORIES.join(" | ")}`,
    );
  }

  const rawStatus = fm["status"];
  if (rawStatus === undefined) {
    return invalid("status", "缺失必填字段");
  }
  if (!isMemoryStatus(rawStatus)) {
    return invalid(
      "status",
      `非法枚举值「${String(rawStatus)}」，合法值: ${MEMORY_STATUSES.join(" | ")}`,
    );
  }

  const rawSource = fm["source"];
  if (rawSource === undefined) {
    return invalid("source", "缺失必填字段");
  }
  if (typeof rawSource !== "string") {
    return invalid("source", "必须为字符串");
  }
  const source = decodeHabitSource(rawSource);
  if (source === undefined) {
    return invalid(
      "source",
      `非法来源编码「${rawSource}」，合法格式: ${HABIT_SOURCE_ENCODING_HINT}`,
    );
  }

  const rawEnabled = fm["enabled"];
  if (rawEnabled === undefined) {
    return invalid("enabled", "缺失必填字段");
  }
  if (typeof rawEnabled !== "boolean") {
    return invalid("enabled", "必须为布尔值（true / false）");
  }

  const rawImportance = fm["importance"];
  if (rawImportance === undefined) {
    return invalid("importance", "缺失必填字段");
  }
  if (typeof rawImportance !== "number" || !Number.isFinite(rawImportance)) {
    return invalid("importance", "必须为有限数字");
  }

  const createdAt = decodeIsoTimestamp(fm["created"]);
  if (createdAt === undefined) {
    return invalid(
      "created",
      fm["created"] === undefined ? "缺失必填字段" : "必须为可解析的 ISO 8601 时间字符串",
    );
  }
  const updatedAt = decodeIsoTimestamp(fm["updated"]);
  if (updatedAt === undefined) {
    return invalid(
      "updated",
      fm["updated"] === undefined ? "缺失必填字段" : "必须为可解析的 ISO 8601 时间字符串",
    );
  }

  const content = decodeHabitBody(parsed.value.body);
  if (content.trim() === "") {
    return invalid("content", "正文（习惯指令文本）不能为空");
  }

  const entry: HabitEntry = {
    id: rawId as HabitEntryId,
    category: rawCategory,
    content,
    status: rawStatus,
    enabled: rawEnabled,
    source,
    importance: rawImportance,
    createdAt,
    updatedAt,
  };
  return { ok: true, value: entry };
}
