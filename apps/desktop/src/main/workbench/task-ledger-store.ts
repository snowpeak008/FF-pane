/**
 * 任务账本的磁盘存储（T11.24，计划 §2、§8）。按项目存，不按管理者存，接任后账本还在。
 *
 * - `.ffpane/tasks/active.json`：只放未完成的任务，管理者读的就是它。
 * - `.ffpane/tasks/backup/`：每次写之前把上一版存进来，只留最近 20 份。
 * - `.ffpane/tasks/archive/YYYY-MM.jsonl`：完成或取消的任务整条追加，只追加不修改，作为长期备份。
 * - `.ffpane/tasks/账本.md`：从 active 生成的人读视图，只给开发和排查看，不手改。
 *
 * 同一项目的读改写按项目串行。active.json 坏了就用最近一份备份恢复，并在返回里标出来。
 */

import { appendFile, copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeTextAtomic } from "@ff-pane/storage";
import { isTaskOpen, isTaskStatus, type LedgerTask, sortForManager } from "./task-ledger";

export const LEDGER_BACKUP_KEEP = 20;

export function tasksDir(projectRoot: string): string {
  return join(resolve(projectRoot), ".ffpane", "tasks");
}

export function activeLedgerPath(projectRoot: string): string {
  return join(tasksDir(projectRoot), "active.json");
}

function backupDir(projectRoot: string): string {
  return join(tasksDir(projectRoot), "backup");
}

function archiveDir(projectRoot: string): string {
  return join(tasksDir(projectRoot), "archive");
}

export function ledgerViewPath(projectRoot: string): string {
  return join(tasksDir(projectRoot), "账本.md");
}

export function archiveFileName(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}.jsonl`;
}

function isLedgerTask(value: unknown): value is LedgerTask {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const item = value as Record<string, unknown>;
  return (
    typeof item["id"] === "string" &&
    item["id"] !== "" &&
    typeof item["title"] === "string" &&
    isTaskStatus(item["status"]) &&
    Array.isArray(item["events"])
  );
}

/** 解析 active.json 正文；不是对象数组、或有一条不合格，整份都算坏。 */
export function parseActiveLedger(text: string): LedgerTask[] | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    const list =
      parsed !== null && typeof parsed === "object"
        ? (parsed as { tasks?: unknown })["tasks"]
        : undefined;
    return Array.isArray(list) && list.every(isLedgerTask) ? (list as LedgerTask[]) : undefined;
  } catch {
    return undefined;
  }
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** 备份文件名带毫秒时间戳，按名字倒序就是新的在前。 */
async function listBackups(projectRoot: string): Promise<string[]> {
  try {
    const names = await readdir(backupDir(projectRoot));
    return names
      .filter((name) => /^active-\d+\.json$/.test(name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export interface LedgerReadResult {
  readonly tasks: readonly LedgerTask[];
  /** active.json 坏了，这份是从备份恢复的。 */
  readonly recovered: boolean;
}

/** 读未完成账本。文件不存在是空账本；坏了依次试备份，都不行才当空账本并标 recovered。 */
export async function readOpenLedger(projectRoot: string): Promise<LedgerReadResult> {
  const text = await readIfPresent(activeLedgerPath(projectRoot));
  if (text === undefined) {
    return { tasks: [], recovered: false };
  }
  const parsed = parseActiveLedger(text);
  if (parsed !== undefined) {
    return { tasks: parsed, recovered: false };
  }
  for (const name of await listBackups(projectRoot)) {
    const backup = await readIfPresent(join(backupDir(projectRoot), name));
    const restored = backup === undefined ? undefined : parseActiveLedger(backup);
    if (restored !== undefined) {
      return { tasks: restored, recovered: true };
    }
  }
  return { tasks: [], recovered: true };
}

/** 人读视图：未完成的任务按管理者的顺序列出。 */
export function renderLedgerView(tasks: readonly LedgerTask[]): string {
  const lines = ["# 任务账本（未完成）", "", "由平台生成，不要手改。已完成的在 archive/ 里。", ""];
  if (tasks.length === 0) {
    lines.push("现在没有未完成的任务。", "");
    return lines.join("\n");
  }
  for (const task of sortForManager(tasks)) {
    const who = task.assignee !== undefined ? `，负责：${task.assignee.title}` : "";
    const sub = task.parentId !== undefined ? `（子任务，属于 ${task.parentId}）` : "";
    lines.push(`- [${task.status}] ${task.title}${sub}（${task.id}）${who}`);
    if (task.progress !== undefined && task.progress !== "") {
      lines.push(`  - 执行情况：${task.progress}`);
    }
  }
  lines.push("");
  return lines.join("\n");
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

async function backupCurrent(projectRoot: string, now: number): Promise<void> {
  const dir = backupDir(projectRoot);
  await mkdir(dir, { recursive: true });
  await copyFile(activeLedgerPath(projectRoot), join(dir, `active-${now}.json`));
  for (const name of (await listBackups(projectRoot)).slice(LEDGER_BACKUP_KEEP)) {
    await rm(join(dir, name), { force: true });
  }
}

export interface LedgerMutation {
  /** 改完后的全部任务（含这次刚结束的）。结束的会被移进归档。 */
  readonly tasks: readonly LedgerTask[];
}

export interface LedgerUpdateResult {
  readonly open: readonly LedgerTask[];
  /** 这次移进归档的任务。 */
  readonly archived: readonly LedgerTask[];
  readonly recovered: boolean;
}

/**
 * 读改写：fn 拿到当前未完成的任务，返回改完后的全部任务。
 * 结束的（done、cancelled）先追加进当月归档，再从 active 里去掉；写之前备份上一版。
 * 归档先于 active 写：中途崩溃最多是同一条在两边都有，不会丢。
 */
export function updateLedger(
  projectRoot: string,
  fn: (open: readonly LedgerTask[]) => LedgerMutation,
  now: () => number = Date.now,
): Promise<LedgerUpdateResult> {
  return runSerial(resolve(projectRoot), async () => {
    const current = await readOpenLedger(projectRoot);
    const next = fn(current.tasks).tasks;
    const open = next.filter((task) => isTaskOpen(task.status));
    const closed = next.filter((task) => !isTaskOpen(task.status));
    const at = now();
    if (closed.length > 0) {
      await mkdir(archiveDir(projectRoot), { recursive: true });
      await appendFile(
        join(archiveDir(projectRoot), archiveFileName(at)),
        `${closed.map((task) => JSON.stringify(task)).join("\n")}\n`,
        "utf8",
      );
    }
    if ((await readIfPresent(activeLedgerPath(projectRoot))) !== undefined) {
      await backupCurrent(projectRoot, at);
    }
    await writeTextAtomic(
      activeLedgerPath(projectRoot),
      `${JSON.stringify({ tasks: open }, null, 2)}\n`,
    );
    await writeTextAtomic(ledgerViewPath(projectRoot), renderLedgerView(open));
    return { open, archived: closed, recovered: current.recovered };
  });
}
