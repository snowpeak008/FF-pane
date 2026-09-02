/**
 * 对话回放本（T8.2b，设计文档 §10.2 规则 3 修订版）：
 * `<项目>/.workbench/sessions/<localSessionId>/transcript.jsonl`，一行一条 TranscriptEntry。
 *
 * 为什么是 append-only JSONL 而不是整文件 JSON 原子写：
 * - 一轮要写两到三条（用户提示词在开头、assistant 文本与收尾在末尾），整文件读改写会让
 *   每条追加的代价随会话长度线性增长，百条消息的会话每轮多读写几十 KB；
 * - 崩溃时 JSONL 最坏只坏最后一行，整文件方案最坏丢整个文件（原子写能兜住，但兜住的
 *   代价是上一条）；
 * - 读侧对坏行「跳过并计数、不抛」，一行损坏不该让整段对话消失（§1.4 红线 3：系统边界
 *   失败路径可理解——计数交给界面如实标注）。
 *
 * 追加的原子性：同进程内对同一文件的追加经 per-file promise 链串行化（两轮交错写同一会话
 * 时各条仍整行落盘，见 tests/transcripts.test.ts「交错追加」）；跨进程无并发写者（主进程
 * 编排器是唯一写者）。每条以 JSON.stringify 单行序列化——字符串内的换行被转义，故"一行
 * 一条"由序列化本身保证，无需额外分隔协议。
 */

import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { LocalSessionId, TranscriptEntry } from "@ff-pane/shared";
import {
  isRole,
  isRunEndReason,
  isSessionResumeKind,
  isTranscriptEntryKind,
} from "@ff-pane/shared";
import { ensureDir, type ProjectLayout, readText, StorageIoError } from "../fs/index.js";
import { sanitizeIdForFileName } from "../records/file-names.js";

/** 会话目录内回放本文件名。 */
export const TRANSCRIPT_FILE_NAME = "transcript.jsonl";

/** 某个会话回放本的落盘路径。 */
export interface TranscriptPaths {
  /** sessions/<localSessionId>/ 目录。 */
  readonly sessionDir: string;
  /** transcript.jsonl。 */
  readonly transcriptFile: string;
}

/** 解析某个会话回放本的路径（纯函数，不触碰文件系统）。ID 经文件名安全化。 */
export function resolveTranscriptPaths(
  layout: ProjectLayout,
  sessionId: LocalSessionId,
): TranscriptPaths {
  const sessionDir = join(layout.sessionsDir, sanitizeIdForFileName(sessionId));
  return { sessionDir, transcriptFile: join(sessionDir, TRANSCRIPT_FILE_NAME) };
}

/** 同进程内 per-file 的追加串行链：保证两个并发追加不会把彼此的行写串。 */
const appendChains = new Map<string, Promise<void>>();

function serializeAppend(filePath: string, work: () => Promise<void>): Promise<void> {
  const previous = appendChains.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  appendChains.set(filePath, next);
  // 链尾结算后清掉引用，避免 Map 随会话数无限增长（下次追加从空链重新开始即可）。
  void next.finally(() => {
    if (appendChains.get(filePath) === next) {
      appendChains.delete(filePath);
    }
  });
  return next;
}

/**
 * 追加一条回放本条目（一行）。父目录缺失时自动补建。失败抛 StorageIoError。
 * 同一会话的并发追加在进程内串行化，行序 = 调用到达序。
 */
export function appendTranscriptEntry(
  layout: ProjectLayout,
  sessionId: LocalSessionId,
  entry: TranscriptEntry,
): Promise<void> {
  const { sessionDir, transcriptFile } = resolveTranscriptPaths(layout, sessionId);
  const line = `${JSON.stringify(entry)}\n`;
  return serializeAppend(transcriptFile, async () => {
    await ensureDir(sessionDir);
    try {
      await appendFile(transcriptFile, line, "utf8");
    } catch (error) {
      throw new StorageIoError(transcriptFile, "回放本追加失败", { cause: error });
    }
  });
}

/** readTranscript 的结果：条目 + 被跳过的坏行数。 */
export interface TranscriptReadResult {
  /** 合法条目，按文件顺序（即写入顺序）。 */
  readonly entries: readonly TranscriptEntry[];
  /** 无法解析或形状非法而被跳过的行数（0 = 文件完好）。 */
  readonly skippedLines: number;
}

/** readTranscript 的选项。 */
export interface ReadTranscriptOptions {
  /** 只取末尾 N 条合法条目（缺省 = 全部）。坏行计数仍统计整个文件。 */
  readonly tail?: number;
}

function hasStringField(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string";
}

function hasOptionalStringField(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === "string";
}

/**
 * 读入边界的形状校验：只校验会破坏后续消费的字段（判别字段、必填字符串、字面量守卫）。
 * 不合法 → undefined（调用方计入 skippedLines）。
 */
function parseTranscriptLine(line: string): TranscriptEntry | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (
    !isTranscriptEntryKind(record["kind"]) ||
    !hasStringField(record, "turnId") ||
    typeof record["at"] !== "number"
  ) {
    return undefined;
  }
  switch (record["kind"]) {
    case "user_message":
      if (
        !hasStringField(record, "text") ||
        !hasOptionalStringField(record, "taskId") ||
        !hasOptionalStringField(record, "runId")
      ) {
        return undefined;
      }
      break;
    case "assistant_message":
      if (
        !hasStringField(record, "text") ||
        (record["partial"] !== undefined && record["partial"] !== true)
      ) {
        return undefined;
      }
      break;
    case "turn_end":
      if (
        !isRole(record["role"]) ||
        !hasStringField(record, "profileId") ||
        !isRunEndReason(record["endReason"]) ||
        (record["resumeKind"] !== undefined && !isSessionResumeKind(record["resumeKind"])) ||
        !hasOptionalStringField(record, "taskId") ||
        !hasOptionalStringField(record, "runId")
      ) {
        return undefined;
      }
      break;
  }
  // JSON 边界：形状已逐字段校验，按 W1.1 约定 as 收窄品牌类型一次
  return record as unknown as TranscriptEntry;
}

/**
 * 读取某会话的回放本。文件不存在 = 空回放本（尚未聊过，常态分支）；其余读故障抛
 * StorageIoError。坏行跳过并计数，不抛、不隔离——JSONL 的其余行仍完好可用，
 * 隔离整文件反而把好的也拿走了。
 */
export async function readTranscript(
  layout: ProjectLayout,
  sessionId: LocalSessionId,
  options: ReadTranscriptOptions = {},
): Promise<TranscriptReadResult> {
  const { transcriptFile } = resolveTranscriptPaths(layout, sessionId);
  const result = await readText(transcriptFile);
  if (!result.ok) {
    if (result.error.code === "not-found") {
      return { entries: [], skippedLines: 0 };
    }
    throw result.error;
  }
  const entries: TranscriptEntry[] = [];
  let skippedLines = 0;
  for (const rawLine of result.value.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const entry = parseTranscriptLine(line);
    if (entry === undefined) {
      skippedLines += 1;
      continue;
    }
    entries.push(entry);
  }
  const tail = options.tail;
  if (tail !== undefined && tail >= 0 && entries.length > tail) {
    return { entries: entries.slice(entries.length - tail), skippedLines };
  }
  return { entries, skippedLines };
}
