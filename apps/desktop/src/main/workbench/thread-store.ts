/**
 * 窗口消息落盘（T10.7a）。
 * index.jsonl 一行一条；人读 Markdown 按团队追加。
 * 主进程按项目串行追加。最后一行半写时读取会跳过。
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { WorkbenchAuthNode } from "@ff-pane/core";
import { walkAncestors } from "@ff-pane/core";
import type { WorkbenchRole } from "@ff-pane/shared";
import { isInsideRoot } from "./brief-files";
import {
  hasControlChar,
  quoteThreadBody,
  type ReportStatus,
  sanitizeThreadText,
  stripControls,
  WORKBENCH_ROLE_LABEL,
} from "./remind";

export interface ThreadParty {
  readonly windowId: string;
  readonly title: string;
  readonly role: WorkbenchRole;
}

export interface ThreadRecord {
  readonly v: 1;
  readonly id: string;
  readonly ts: string;
  readonly projectId: string;
  readonly from: ThreadParty;
  readonly to: ThreadParty;
  readonly kind: "message" | "report";
  readonly status?: ReportStatus;
  readonly text: string;
  readonly files?: readonly string[];
  readonly briefPath?: string;
  readonly threadFile: string;
}

const queues = new Map<string, Promise<unknown>>();

function runSerial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  queues.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export function threadsDir(projectRoot: string): string {
  return join(resolve(projectRoot), ".ffpane", "threads");
}

function localParts(date: Date): { readonly day: string; readonly clock: string } {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return { day: `${y}-${m}-${d}`, clock: `${hh}:${mm}:${ss}` };
}

function chainFarFirst(
  windowId: string,
  tree: Readonly<Record<string, WorkbenchAuthNode>>,
): readonly string[] {
  const walk = walkAncestors(windowId, tree);
  if (walk.cycle || walk.truncated) {
    return [windowId];
  }
  return [...walk.ids].reverse().concat(windowId);
}

/** 双方所在的最上层管理者；没有管理者时用调用方链上最远的窗口。 */
export function teamAnchorId(
  fromId: string,
  toId: string,
  tree: Readonly<Record<string, WorkbenchAuthNode>>,
): string {
  const pick = (id: string): string | undefined => {
    for (const item of chainFarFirst(id, tree)) {
      if (tree[item]?.role === "manager") {
        return item;
      }
    }
    return undefined;
  };
  return pick(fromId) ?? pick(toId) ?? chainFarFirst(fromId, tree)[0] ?? fromId;
}

export function teamFileSlug(title: string, windowId: string): string {
  const cleaned = stripControls(title)
    .replace(/[\\/:*?"<>|]/g, "")
    .trim()
    .slice(0, 40);
  const slug = cleaned.length > 0 ? cleaned : "team";
  const short = windowId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6) || "win";
  return `${slug}-${short}`;
}

export function threadFileName(date: Date, title: string, windowId: string): string {
  const { day } = localParts(date);
  return `${day}-${teamFileSlug(title, windowId)}.md`;
}

export function formatThreadBlock(record: ThreadRecord, date: Date): string {
  const { clock } = localParts(date);
  const fromRole = WORKBENCH_ROLE_LABEL[record.from.role];
  const toRole = WORKBENCH_ROLE_LABEL[record.to.role];
  const kind = record.kind === "report" ? `汇报:${record.status ?? "progress"}` : "消息";
  const fromTitle = sanitizeThreadText(record.from.title) || "窗口";
  const toTitle = sanitizeThreadText(record.to.title) || "窗口";
  const lines = [
    `### ${clock} · ${fromRole}「${fromTitle}」→ ${toRole}「${toTitle}」· ${kind}`,
    "",
    quoteThreadBody(record.text),
    "",
  ];
  if (record.files !== undefined && record.files.length > 0) {
    const files = record.files
      .map((file) => sanitizeThreadText(file))
      .filter((file) => file !== "");
    if (files.length > 0) {
      lines.push(`附件：${files.join("、")}`, "");
    }
  }
  if (record.briefPath !== undefined && record.briefPath.trim() !== "") {
    lines.push(`说明：${sanitizeThreadText(record.briefPath)}`, "");
  }
  return lines.join("\n");
}

function isParty(value: unknown): value is ThreadParty {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const raw = value as Record<string, unknown>;
  return (
    typeof raw["windowId"] === "string" &&
    typeof raw["title"] === "string" &&
    typeof raw["role"] === "string"
  );
}

export function parseThreadLine(line: string): ThreadRecord | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object") {
      return undefined;
    }
    const raw = parsed as Record<string, unknown>;
    if (
      raw["v"] !== 1 ||
      typeof raw["id"] !== "string" ||
      !isParty(raw["from"]) ||
      !isParty(raw["to"])
    ) {
      return undefined;
    }
    if (raw["kind"] !== "message" && raw["kind"] !== "report") {
      return undefined;
    }
    return parsed as ThreadRecord;
  } catch {
    return undefined;
  }
}

/** 跳过空行和解析失败的行（含崩溃时最后一行半写）。 */
export function readThreadIndexText(text: string): readonly ThreadRecord[] {
  const out: ThreadRecord[] = [];
  for (const line of text.split("\n")) {
    const record = parseThreadLine(line);
    if (record !== undefined) {
      out.push(record);
    }
  }
  return out;
}

export async function readThreadIndex(projectRoot: string): Promise<readonly ThreadRecord[]> {
  try {
    const text = await readFile(join(threadsDir(projectRoot), "index.jsonl"), "utf8");
    return readThreadIndexText(text);
  } catch {
    return [];
  }
}

export function appendThreadRecord(
  projectRoot: string,
  record: ThreadRecord,
  date = new Date(record.ts),
): Promise<void> {
  const root = resolve(projectRoot);
  return runSerial(root, async () => {
    const dir = threadsDir(root);
    await mkdir(dir, { recursive: true });
    const indexPath = join(dir, "index.jsonl");
    const threadPath = join(dir, record.threadFile);
    if (!isInsideRoot(dir, threadPath)) {
      throw new Error("thread file escaped threads directory");
    }
    const block = formatThreadBlock(record, Number.isNaN(date.getTime()) ? new Date() : date);
    await appendFile(indexPath, `${JSON.stringify(record)}\n`, "utf8");
    await appendFile(threadPath, `${block}\n`, "utf8");
  });
}

export function latestReportStatus(
  records: readonly ThreadRecord[],
  windowId: string,
): ReportStatus | undefined {
  let status: ReportStatus | undefined;
  for (const record of records) {
    if (
      record.kind === "report" &&
      record.from.windowId === windowId &&
      record.status !== undefined
    ) {
      status = record.status;
    }
  }
  return status;
}

/** 项目内相对路径，拒绝绝对路径、.. 和越界。 */
export async function assertProjectFiles(
  projectRoot: string,
  files: readonly string[],
): Promise<
  | { readonly ok: true; readonly files: readonly string[] }
  | { readonly ok: false; readonly error: string }
> {
  const root = resolve(projectRoot);
  const out: string[] = [];
  for (const file of files) {
    if (typeof file !== "string" || file.trim() === "" || hasControlChar(file)) {
      return { ok: false, error: "files 含有无效路径。" };
    }
    if (
      file.includes("..") ||
      file.startsWith("/") ||
      file.startsWith("\\") ||
      /^[a-zA-Z]:/.test(file)
    ) {
      return { ok: false, error: `路径越界：${file}` };
    }
    const absolute = resolve(root, file);
    if (!isInsideRoot(root, absolute)) {
      return { ok: false, error: `路径越界：${file}` };
    }
    const rel = relative(root, absolute);
    if (rel.startsWith("..") || rel.includes(`..${sep}`)) {
      return { ok: false, error: `路径越界：${file}` };
    }
    out.push(rel.split(sep).join("/"));
  }
  return { ok: true, files: out };
}
