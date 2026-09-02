/**
 * 在飞轮次标记与部分文本（T8.2b）：`<项目>/.workbench/sessions/inflight/`。
 *
 * - `<turnId>.json`：轮开始时写、正常收尾时删。工作台退出 / 崩溃后残留 = 该轮被中断，
 *   启动修正据此补 Run(interrupted) / 推进任务 / 补 transcript 收尾；
 * - `<turnId>.partial.txt`：流式过程中节流覆盖写的 assistant 部分文本。它不是回放本
 *   的一部分（回放本只在收尾时落完整文本），只在被中断时被抢救成 `assistant_message{partial}`。
 *
 * 两个文件都走 W1.2a 原子写：标记半写等于"不存在"，修正逻辑读不到半个标记。
 * 删除用 `rm({ force: true })`：收尾时标记可能已被并行的退出钩子删过，重复删不是错误。
 */

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { InflightTurnMarker } from "@ff-pane/shared";
import { isRole, isSessionResumeKind } from "@ff-pane/shared";
import {
  errnoCodeOf,
  type ProjectLayout,
  readJson,
  readText,
  StorageIoError,
  writeJsonAtomic,
  writeTextAtomic,
} from "../fs/index.js";
import { sanitizeIdForFileName } from "../records/file-names.js";

/** 标记文件后缀。 */
export const INFLIGHT_MARKER_SUFFIX = ".json";

/** 部分文本文件后缀。 */
export const INFLIGHT_PARTIAL_SUFFIX = ".partial.txt";

/** 某个在飞轮次的两个落盘路径。 */
export interface InflightPaths {
  readonly markerFile: string;
  readonly partialFile: string;
}

/** 解析某轮的标记 / 部分文本路径（纯函数）。turnId 经文件名安全化。 */
export function resolveInflightPaths(layout: ProjectLayout, turnId: string): InflightPaths {
  const base = join(layout.sessionsInflightDir, sanitizeIdForFileName(turnId));
  return {
    markerFile: `${base}${INFLIGHT_MARKER_SUFFIX}`,
    partialFile: `${base}${INFLIGHT_PARTIAL_SUFFIX}`,
  };
}

/** 落位一条在飞标记（原子写，自动补建目录）。 */
export async function writeInflightMarker(
  layout: ProjectLayout,
  marker: InflightTurnMarker,
): Promise<void> {
  await writeJsonAtomic(resolveInflightPaths(layout, marker.turnId).markerFile, marker);
}

/**
 * 删除某轮的标记与部分文本（两者都按「不存在也算成功」处理）。
 * 返回标记文件此前是否存在——修正逻辑据此判断"是我删的"还是"早就没了"。
 */
export async function deleteInflightMarker(
  layout: ProjectLayout,
  turnId: string,
): Promise<boolean> {
  const { markerFile, partialFile } = resolveInflightPaths(layout, turnId);
  const existed = (await readText(markerFile)).ok;
  try {
    await rm(markerFile, { force: true });
    await rm(partialFile, { force: true });
  } catch (error) {
    throw new StorageIoError(markerFile, "删除在飞标记失败", { cause: error });
  }
  return existed;
}

/** 覆盖写某轮的部分文本（原子写）。 */
export async function writeInflightPartial(
  layout: ProjectLayout,
  turnId: string,
  text: string,
): Promise<void> {
  await writeTextAtomic(resolveInflightPaths(layout, turnId).partialFile, text);
}

/** 读某轮的部分文本；不存在返回 undefined，其余读故障抛 StorageIoError。 */
export async function readInflightPartial(
  layout: ProjectLayout,
  turnId: string,
): Promise<string | undefined> {
  const result = await readText(resolveInflightPaths(layout, turnId).partialFile);
  if (result.ok) {
    return result.value;
  }
  if (result.error.code === "not-found") {
    return undefined;
  }
  throw result.error;
}

/** listInflightMarkers 里单个标记文件读不出来时的记录（不阻断其余标记）。 */
export interface InflightMarkerIssue {
  readonly path: string;
  readonly message: string;
}

/** listInflightMarkers 的结果。 */
export interface InflightMarkersListing {
  /** 合法标记，按文件名排序（确定性）。 */
  readonly markers: readonly InflightTurnMarker[];
  /** 读失败 / 形状非法的标记文件（JSON 语法损坏者已由 W1.2a 隔离为 .corrupt-*）。 */
  readonly issues: readonly InflightMarkerIssue[];
}

/** 读入边界形状校验：判别字段与必填字符串；不合法 → undefined。 */
function validateMarker(raw: unknown): InflightTurnMarker | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const optionalString = (key: string): boolean =>
    record[key] === undefined || typeof record[key] === "string";
  if (
    typeof record["turnId"] !== "string" ||
    typeof record["sessionId"] !== "string" ||
    !isRole(record["role"]) ||
    typeof record["profileId"] !== "string" ||
    typeof record["startedAt"] !== "number" ||
    (record["resumeKind"] !== undefined && !isSessionResumeKind(record["resumeKind"])) ||
    !optionalString("taskId") ||
    !optionalString("runId")
  ) {
    return undefined;
  }
  return record as unknown as InflightTurnMarker;
}

/**
 * 列出全部在飞标记。inflight/ 目录不存在 = 空集（从未跑过轮次的项目，常态）。
 * 单个标记文件读失败或形状非法进 issues，不阻断其余标记（一个坏标记不该让别的
 * 被中断轮次得不到修正）。
 */
export async function listInflightMarkers(layout: ProjectLayout): Promise<InflightMarkersListing> {
  let names: readonly string[];
  try {
    names = await readdir(layout.sessionsInflightDir);
  } catch (error) {
    if (errnoCodeOf(error) === "ENOENT") {
      return { markers: [], issues: [] };
    }
    throw new StorageIoError(layout.sessionsInflightDir, "读取在飞标记目录失败", {
      cause: error,
    });
  }
  const markers: InflightTurnMarker[] = [];
  const issues: InflightMarkerIssue[] = [];
  for (const name of names.filter((n) => n.endsWith(INFLIGHT_MARKER_SUFFIX)).toSorted()) {
    const filePath = join(layout.sessionsInflightDir, name);
    const result = await readJson<unknown>(filePath);
    if (!result.ok) {
      issues.push({ path: filePath, message: result.error.message });
      continue;
    }
    const marker = validateMarker(result.value);
    if (marker === undefined) {
      issues.push({ path: filePath, message: "在飞标记字段非法" });
      continue;
    }
    markers.push(marker);
  }
  return { markers, issues };
}
