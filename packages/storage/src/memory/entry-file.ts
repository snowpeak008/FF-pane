/**
 * MemoryEntry 条目文件编解码（W1.2c）：一条一文件（<id>.md）。
 *
 * 文件格式 = 受控 frontmatter（frontmatter.ts 子集）+ Markdown 正文：
 * - frontmatter 承载 id / category / status / source / confidence / created /
 *   updated / supersedes / tags；title 不入 frontmatter——正文首行一级标题
 *   `# <标题>` 即标题（§8.4 人类可读），标题行之后空一行接 body，body 允许为空。
 * - created / updated 序列化为 ISO 8601 UTC 字符串（毫秒精度，与 EpochMillis
 *   无损往返），供任意编辑器直接阅读。
 * - source 序列化格式（本工单定义，作为持久层约定）：
 *   `user_manual` | `agent_proposed` | `task:<taskId>` | `plan:<正整数版本>`。
 *   与设计文档 §8.1 原文 task_<id> 的差异：改用冒号分隔，避免与 user_manual /
 *   agent_proposed 自身的下划线产生解析歧义。
 * - 读入容忍策略（W1.2c 决策）：未知 frontmatter key 一律忽略，不导致拒读——
 *   用户手加的扩展键不破坏系统；但条目重写（saveEntry / updateEntryStatus）
 *   按规范形态重新生成，未知 key 不保留。
 * - 编解码类别无关：无任何按 category 的分支，Phase 5 习惯条目可复用同一套
 *   frontmatter + 标题行正文的组合；落位规则全部在 store.ts。
 */

import type {
  EpochMillis,
  MemoryEntry,
  MemoryEntryId,
  MemorySource,
  PlanVersion,
  TaskId,
} from "@ff-pane/shared";
import {
  isMemoryCategory,
  isMemoryConfidence,
  isMemoryStatus,
  MEMORY_CATEGORIES,
  MEMORY_CONFIDENCES,
  MEMORY_STATUSES,
} from "@ff-pane/shared";
import type { MemoryEntryDecodeError, MemoryResult } from "./errors.js";
import { MemoryEncodeError, MemoryEntryFieldError, MemoryFrontmatterError } from "./errors.js";
import type { FrontmatterValue } from "./frontmatter.js";
import { encodeFrontmatterDocument, parseFrontmatterDocument } from "./frontmatter.js";

/** source 合法编码提示（错误信息与文档共用）。 */
export const MEMORY_SOURCE_ENCODING_HINT =
  "user_manual | agent_proposed | task:<taskId> | plan:<正整数版本>";

/** 序列化 MemorySource（格式见模块注释）。 */
export function encodeMemorySource(source: MemorySource): string {
  switch (source.kind) {
    case "user_manual":
      return "user_manual";
    case "agent_proposed":
      return "agent_proposed";
    case "task":
      return `task:${source.taskId}`;
    case "plan":
      return `plan:${source.planVersion}`;
  }
}

/** 反序列化 MemorySource；不合法返回 undefined（由调用方转成带字段的 typed error）。 */
export function decodeMemorySource(text: string): MemorySource | undefined {
  if (text === "user_manual") {
    return { kind: "user_manual" };
  }
  if (text === "agent_proposed") {
    return { kind: "agent_proposed" };
  }
  if (text.startsWith("task:")) {
    const taskId = text.slice("task:".length);
    return taskId === "" ? undefined : { kind: "task", taskId: taskId as TaskId };
  }
  if (text.startsWith("plan:")) {
    const raw = text.slice("plan:".length);
    if (!/^[1-9]\d*$/.test(raw)) {
      return undefined;
    }
    return { kind: "plan", planVersion: Number(raw) as PlanVersion };
  }
  return undefined;
}

/** EpochMillis → ISO 8601 UTC（毫秒精度，无损往返）。 */
export function encodeIsoTimestamp(epochMillis: EpochMillis): string {
  return new Date(epochMillis).toISOString();
}

/** ISO 8601 字符串 → EpochMillis；缺失 / 非字符串 / 不可解析返回 undefined。 */
export function decodeIsoTimestamp(value: FrontmatterValue | undefined): EpochMillis | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const epochMillis = Date.parse(value);
  return Number.isNaN(epochMillis) ? undefined : epochMillis;
}

const TITLE_LINE_PATTERN = /^# (.*)$/;

/**
 * 组装「一级标题 + 正文」的 Markdown 文本：`# <title>`，非空 body 前空一行，
 * 文件以换行收尾。decodeTitledMarkdownBody 的精确逆运算。
 */
export function encodeTitledMarkdownBody(title: string, body: string): string {
  if (/[\n\r]/.test(title)) {
    throw new MemoryEncodeError(`标题不允许包含换行: ${JSON.stringify(title)}`);
  }
  return body === "" ? `# ${title}\n` : `# ${title}\n\n${body}\n`;
}

/** decodeTitledMarkdownBody 的判别联合结果。 */
export type TitledMarkdownBody =
  | { readonly ok: true; readonly title: string; readonly body: string }
  | { readonly ok: false; readonly reason: string };

/** 拆解「一级标题 + 正文」。容忍手写文件省略标题后的空行。 */
export function decodeTitledMarkdownBody(text: string): TitledMarkdownBody {
  const content = text.endsWith("\n") ? text.slice(0, -1) : text;
  const newlineIndex = content.indexOf("\n");
  const firstLine = newlineIndex === -1 ? content : content.slice(0, newlineIndex);
  const match = TITLE_LINE_PATTERN.exec(firstLine);
  if (match === null) {
    return { ok: false, reason: "正文必须以一级标题行「# <标题>」开头（标题不入 frontmatter）" };
  }
  const title = match[1] ?? "";
  if (newlineIndex === -1) {
    return { ok: true, title, body: "" };
  }
  let body = content.slice(newlineIndex + 1);
  if (body.startsWith("\n")) {
    body = body.slice(1);
  }
  return { ok: true, title, body };
}

/** 编码一条 MemoryEntry 为条目文件全文。key 顺序固定，保证干净的 Git diff。 */
export function encodeMemoryEntryFile(entry: MemoryEntry): string {
  const frontmatter: Record<string, FrontmatterValue> = {
    id: entry.id,
    category: entry.category,
    status: entry.status,
    source: encodeMemorySource(entry.source),
    confidence: entry.confidence,
    created: encodeIsoTimestamp(entry.createdAt),
    updated: encodeIsoTimestamp(entry.updatedAt),
  };
  if (entry.supersedes !== undefined) {
    frontmatter["supersedes"] = entry.supersedes;
  }
  if (entry.tags !== undefined) {
    frontmatter["tags"] = entry.tags;
  }
  return encodeFrontmatterDocument({
    frontmatter,
    body: encodeTitledMarkdownBody(entry.title, entry.body),
  });
}

/** 解码条目文件全文。filePath 只用于错误上下文，不参与解码。 */
export function decodeMemoryEntryFile(
  text: string,
  filePath: string,
): MemoryResult<MemoryEntry, MemoryEntryDecodeError> {
  const parsed = parseFrontmatterDocument(text);
  if (!parsed.ok) {
    return {
      ok: false,
      error: new MemoryFrontmatterError(filePath, parsed.issue.line, parsed.issue.reason),
    };
  }
  const fm = parsed.value.frontmatter;
  const invalid = (
    field: string,
    reason: string,
  ): MemoryResult<MemoryEntry, MemoryEntryDecodeError> => ({
    ok: false,
    error: new MemoryEntryFieldError(filePath, field, reason),
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
  if (!isMemoryCategory(rawCategory)) {
    return invalid(
      "category",
      `非法枚举值「${String(rawCategory)}」，合法值: ${MEMORY_CATEGORIES.join(" | ")}`,
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
  const source = decodeMemorySource(rawSource);
  if (source === undefined) {
    return invalid(
      "source",
      `非法来源编码「${rawSource}」，合法格式: ${MEMORY_SOURCE_ENCODING_HINT}`,
    );
  }

  const rawConfidence = fm["confidence"];
  if (rawConfidence === undefined) {
    return invalid("confidence", "缺失必填字段");
  }
  if (!isMemoryConfidence(rawConfidence)) {
    return invalid(
      "confidence",
      `非法枚举值「${String(rawConfidence)}」，合法值: ${MEMORY_CONFIDENCES.join(" | ")}`,
    );
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

  const rawSupersedes = fm["supersedes"];
  if (rawSupersedes !== undefined && (typeof rawSupersedes !== "string" || rawSupersedes === "")) {
    return invalid("supersedes", "必须为非空字符串");
  }

  const rawTags = fm["tags"];
  let tags: readonly string[] | undefined;
  if (rawTags !== undefined) {
    if (!Array.isArray(rawTags)) {
      return invalid("tags", "必须为数组（如 tags: [甲, 乙]）");
    }
    const collected: string[] = [];
    for (const tag of rawTags) {
      if (typeof tag !== "string") {
        return invalid("tags", `数组元素必须为字符串，遇到 ${JSON.stringify(tag)}`);
      }
      collected.push(tag);
    }
    tags = collected;
  }

  const titled = decodeTitledMarkdownBody(parsed.value.body);
  if (!titled.ok) {
    return invalid("title", titled.reason);
  }

  const entry: MemoryEntry = {
    id: rawId as MemoryEntryId,
    category: rawCategory,
    title: titled.title,
    body: titled.body,
    status: rawStatus,
    source,
    confidence: rawConfidence,
    createdAt,
    updatedAt,
    ...(rawSupersedes === undefined ? {} : { supersedes: rawSupersedes as MemoryEntryId }),
    ...(tags === undefined ? {} : { tags }),
  };
  return { ok: true, value: entry };
}
