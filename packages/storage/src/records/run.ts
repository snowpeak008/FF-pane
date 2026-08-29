/**
 * Run 读写（W1.2b）：runs/run-<id>/ 目录三件套（设计文档 §6.4 / §10.2）——
 * run.json（结构化执行记录）+ changes.diff（文件修改证据）+ raw.log（原始日志）。
 *
 * 证据文件约定：diff 与日志是体积不可控的自由文本，另存独立文件；run.json 内
 * 只存相对文件名（rawLogPath 一律形如 "raw.log"，不含目录分隔符），Run 目录
 * 因此可整体拷贝迁移。saveRun 在写入侧强制这一约定（类型系统表达不了）。
 */

import { join } from "node:path";
import type { Run, RunId, TaskId } from "@ff-pane/shared";
import { isRunEndReason } from "@ff-pane/shared";
import type { ProjectLayout, ReadTextResult } from "../fs/index.js";
import { readJson, readText, writeJsonAtomic, writeTextAtomic } from "../fs/index.js";
import type { RecordResult } from "./errors.js";
import { StorageInvalidRecordError } from "./errors.js";
import { runDirName } from "./file-names.js";
import { readDirNames } from "./read-dir.js";

/** Run 目录内结构化记录的文件名（设计文档 §10.2）。 */
export const RUN_JSON_FILE_NAME = "run.json";

/** Run 目录内文件修改证据（unified diff 汇总）的文件名（设计文档 §10.2）。 */
export const RUN_CHANGES_DIFF_FILE_NAME = "changes.diff";

/** Run 目录内原始日志的文件名（设计文档 §10.2；默认进 .gitignore，见 §10.2 规则 2）。 */
export const RUN_RAW_LOG_FILE_NAME = "raw.log";

/** 单个 Run 的全部落盘路径。 */
export interface RunPaths {
  /** runs/run-<id>/ 目录。 */
  readonly runDir: string;
  /** run.json —— 结构化执行记录。 */
  readonly runJsonFile: string;
  /** changes.diff —— 文件修改证据。 */
  readonly changesDiffFile: string;
  /** raw.log —— 原始日志。 */
  readonly rawLogFile: string;
}

/** 解析某个 Run 的全部落盘路径（纯函数，不触碰文件系统）。 */
export function resolveRunPaths(layout: ProjectLayout, runId: RunId): RunPaths {
  const runDir = join(layout.runsDir, runDirName(runId));
  return {
    runDir,
    runJsonFile: join(runDir, RUN_JSON_FILE_NAME),
    changesDiffFile: join(runDir, RUN_CHANGES_DIFF_FILE_NAME),
    rawLogFile: join(runDir, RUN_RAW_LOG_FILE_NAME),
  };
}

/** rawLogPath 必须是不含目录分隔符的相对文件名（模块注释的证据文件约定）。 */
function rawLogPathProblem(rawLogPath: string): string | undefined {
  if (rawLogPath.length === 0 || rawLogPath.includes("/") || rawLogPath.includes("\\")) {
    return `rawLogPath 必须是 Run 目录内的相对文件名（如 "${RUN_RAW_LOG_FILE_NAME}"），实际为 ${JSON.stringify(rawLogPath)}`;
  }
  return undefined;
}

/**
 * 保存 Run 结构化记录（原子写 run.json）。返回该 Run 的全部落盘路径。
 * rawLogPath 违反相对文件名约定时抛 StorageInvalidRecordError。
 */
export async function saveRun(layout: ProjectLayout, run: Run): Promise<RunPaths> {
  const paths = resolveRunPaths(layout, run.id);
  const problem = rawLogPathProblem(run.rawLogPath);
  if (problem !== undefined) {
    throw new StorageInvalidRecordError(paths.runJsonFile, "rawLogPath", problem);
  }
  await writeJsonAtomic(paths.runJsonFile, run);
  return paths;
}

/** 读取单个 run.json 并做边界校验（endReason 字面量，仅在字段存在时）。 */
async function loadRunFile(runJsonFile: string): Promise<RecordResult<Run>> {
  const result = await readJson<Run>(runJsonFile);
  if (!result.ok) {
    return result;
  }
  const { endReason } = result.value;
  if (endReason !== undefined && !isRunEndReason(endReason)) {
    return {
      ok: false,
      error: new StorageInvalidRecordError(
        runJsonFile,
        "endReason",
        `Run 结束原因非法: ${JSON.stringify(endReason)}`,
      ),
    };
  }
  return result;
}

/** 按 ID 读取 Run。额外校验文件内 id 与请求一致（防手工改错文件内容）。 */
export async function loadRun(layout: ProjectLayout, id: RunId): Promise<RecordResult<Run>> {
  const { runJsonFile } = resolveRunPaths(layout, id);
  const result = await loadRunFile(runJsonFile);
  if (!result.ok) {
    return result;
  }
  if (result.value.id !== id) {
    return {
      ok: false,
      error: new StorageInvalidRecordError(
        runJsonFile,
        "id",
        `文件内 id ${JSON.stringify(result.value.id)} 与请求的 ${JSON.stringify(id)} 不一致`,
      ),
    };
  }
  return result;
}

function compareRuns(a: Run, b: Run): number {
  if (a.startedAt !== b.startedAt) {
    return a.startedAt - b.startedAt;
  }
  if (a.attempt !== b.attempt) {
    return a.attempt - b.attempt;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

/**
 * 列出全部 Run，可选按所属任务过滤。按 startedAt → attempt → id 排序保证确定性。
 * run.json 缺失的 run-* 条目按常态跳过（saveRun 之前崩溃留下的空目录、或普通文件混入）；
 * 单个 run.json 非法即整体拒读（fail fast）；runs/ 目录不存在视同无记录。
 */
export async function listRuns(
  layout: ProjectLayout,
  taskId?: TaskId,
): Promise<RecordResult<readonly Run[]>> {
  const namesResult = await readDirNames(layout.runsDir);
  if (!namesResult.ok) {
    return namesResult;
  }
  const dirNames = namesResult.value.filter((name) => name.startsWith("run-")).toSorted();
  const runs: Run[] = [];
  for (const dirName of dirNames) {
    const result = await loadRunFile(join(layout.runsDir, dirName, RUN_JSON_FILE_NAME));
    if (!result.ok) {
      if (result.error.code === "not-found") {
        continue;
      }
      return result;
    }
    if (taskId === undefined || result.value.taskId === taskId) {
      runs.push(result.value);
    }
  }
  return { ok: true, value: runs.toSorted(compareRuns) };
}

/** 写入 changes.diff 证据文件（原子写，自动补建 Run 目录）。返回落盘路径。 */
export async function writeRunChangesDiff(
  layout: ProjectLayout,
  runId: RunId,
  diffText: string,
): Promise<string> {
  const { changesDiffFile } = resolveRunPaths(layout, runId);
  await writeTextAtomic(changesDiffFile, diffText);
  return changesDiffFile;
}

/** 写入 raw.log 证据文件（原子写全量内容，自动补建 Run 目录）。返回落盘路径。 */
export async function writeRunRawLog(
  layout: ProjectLayout,
  runId: RunId,
  logText: string,
): Promise<string> {
  const { rawLogFile } = resolveRunPaths(layout, runId);
  await writeTextAtomic(rawLogFile, logText);
  return rawLogFile;
}

/** 读取 changes.diff 证据文件（缺失返回 not-found 结果，不抛异常）。 */
export function readRunChangesDiff(layout: ProjectLayout, runId: RunId): Promise<ReadTextResult> {
  return readText(resolveRunPaths(layout, runId).changesDiffFile);
}

/** 读取 raw.log 证据文件（缺失返回 not-found 结果，不抛异常）。 */
export function readRunRawLog(layout: ProjectLayout, runId: RunId): Promise<ReadTextResult> {
  return readText(resolveRunPaths(layout, runId).rawLogFile);
}
