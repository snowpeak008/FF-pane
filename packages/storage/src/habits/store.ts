/**
 * 习惯（共享记忆）读写 API（T5.1）：全局作用域（设计文档 §8.2 / §10.1
 * ~/.aiworkbench/habits/<category>/<id>.md），一条一文件。Markdown 是唯一真实
 * 数据源，index.sqlite（若接入）从本层 listHabits 重建。
 *
 * 与项目记忆（memory/store.ts）的落位差异：
 * - 习惯全局共享、绑定 GlobalLayout（非 ProjectLayout）。
 * - 无 candidates 子目录：candidate 状态的习惯也落在 category 目录，仅靠
 *   frontmatter 的 status 区分（读侧一律按 frontmatter 过滤，目录只是组织方式）。
 * - 无 state 快照概念。
 *
 * 移动与一致性语义同 memory：saveHabit「先原子写规范新址，再清理同 id 其他
 * 位置的旧副本」（分类变更 = 先写新址再删旧址）；读侧扫描全部分类目录，同 id
 * 冲突取 updatedAt 较新者，残留副本不产生脏读并在下次保存时被清理（自愈）。
 */

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  EpochMillis,
  HabitCategory,
  HabitEntry,
  HabitEntryId,
  MemoryStatus,
} from "@ff-pane/shared";
import type { GlobalLayout } from "../fs/index.js";
import { errnoCodeOf, readText, StorageIoError, writeTextAtomic } from "../fs/index.js";
import type { HabitEntryDecodeError, HabitEntryLoadError, HabitResult } from "./errors.js";
import { HabitEncodeError, HabitEntryFieldError, HabitEntryNotFoundError } from "./errors.js";
import { decodeHabitEntryFile, encodeHabitEntryFile } from "./habit-file.js";

/** 习惯落位只需要分类目录映射，抽出便于测试与复用。 */
export type HabitLayout = Pick<GlobalLayout, "habitCategoryDirs">;

/** 条目文件名约定：<id>.md。 */
export function habitFileName(id: HabitEntryId): string {
  return `${id}.md`;
}

/** 全部分类目录，loadHabit / listHabits 的扫描范围。 */
function allHabitDirs(layout: HabitLayout): readonly string[] {
  return Object.values(layout.habitCategoryDirs);
}

/** id 必须能安全用作文件名：拒绝控制字符、Windows 保留字符与前导点。 */
function isFileNameSafeHabitId(id: string): boolean {
  if (id === "" || id.startsWith(".")) {
    return false;
  }
  for (const ch of id) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || '<>:"/\\|?*'.includes(ch)) {
      return false;
    }
  }
  return true;
}

/** 按落位规则解析条目文件的规范路径（category 目录 + <id>.md）。 */
export function resolveHabitFilePath(
  layout: HabitLayout,
  entry: Pick<HabitEntry, "id" | "category">,
): string {
  return join(layout.habitCategoryDirs[entry.category], habitFileName(entry.id));
}

async function removeStaleHabitCopies(
  layout: HabitLayout,
  id: HabitEntryId,
  keepPath: string,
): Promise<void> {
  for (const dir of allHabitDirs(layout)) {
    const stalePath = join(dir, habitFileName(id));
    if (stalePath === keepPath) {
      continue;
    }
    try {
      await rm(stalePath, { force: true });
    } catch (error) {
      throw new StorageIoError(stalePath, "清理习惯条目旧址失败", { cause: error });
    }
  }
}

/**
 * 保存条目：按分类自动落位（原子写），随后清理同 id 的其他旧址——分类变化时
 * 等价于「先写新址再删旧址」的移动。返回写入的规范路径。
 */
export async function saveHabit(layout: HabitLayout, entry: HabitEntry): Promise<string> {
  if (!isFileNameSafeHabitId(entry.id)) {
    throw new HabitEncodeError(
      `习惯条目 id 无法用作文件名（不允许控制字符、<>:"/\\|?* 与前导点）: ${entry.id}`,
    );
  }
  const targetPath = resolveHabitFilePath(layout, entry);
  await writeTextAtomic(targetPath, encodeHabitEntryFile(entry));
  await removeStaleHabitCopies(layout, entry.id, targetPath);
  return targetPath;
}

/**
 * 按 id 跨目录寻址读取条目。文件名必须与 frontmatter id 一致，不一致按
 * invalid-entry 拒读；同 id 多处命中（崩溃残留）取 updatedAt 较新者。
 */
export async function loadHabit(
  layout: HabitLayout,
  id: HabitEntryId,
): Promise<HabitResult<HabitEntry, HabitEntryLoadError>> {
  const dirs = allHabitDirs(layout);
  let best: HabitEntry | undefined;
  for (const dir of dirs) {
    const filePath = join(dir, habitFileName(id));
    const read = await readText(filePath);
    if (!read.ok) {
      if (read.error.code === "not-found") {
        continue;
      }
      return { ok: false, error: read.error };
    }
    const decoded = decodeHabitEntryFile(read.value, filePath);
    if (!decoded.ok) {
      return decoded;
    }
    if (decoded.value.id !== id) {
      return {
        ok: false,
        error: new HabitEntryFieldError(
          filePath,
          "id",
          `frontmatter id「${decoded.value.id}」与文件名不一致`,
        ),
      };
    }
    if (best === undefined || decoded.value.updatedAt > best.updatedAt) {
      best = decoded.value;
    }
  }
  if (best === undefined) {
    return { ok: false, error: new HabitEntryNotFoundError(id, dirs) };
  }
  return { ok: true, value: best };
}

/**
 * 状态流转：改写 status 与 updatedAt 后按落位保存。只做机械移动，不校验流转
 * 方向（candidate→active 的业务规则由上层触发）。
 */
export async function updateHabitStatus(
  layout: HabitLayout,
  id: HabitEntryId,
  status: MemoryStatus,
  updatedAt: EpochMillis = Date.now(),
): Promise<HabitResult<HabitEntry, HabitEntryLoadError>> {
  const loaded = await loadHabit(layout, id);
  if (!loaded.ok) {
    return loaded;
  }
  const updated: HabitEntry = { ...loaded.value, status, updatedAt };
  await saveHabit(layout, updated);
  return { ok: true, value: updated };
}

/**
 * 单条启用开关（§8.2.4「可单条停用」）：改写 enabled 与 updatedAt 后保存。
 * enabled=false 表示保留条目但不参与 Prompt 组装，与 archived 语义区分。
 */
export async function setHabitEnabled(
  layout: HabitLayout,
  id: HabitEntryId,
  enabled: boolean,
  updatedAt: EpochMillis = Date.now(),
): Promise<HabitResult<HabitEntry, HabitEntryLoadError>> {
  const loaded = await loadHabit(layout, id);
  if (!loaded.ok) {
    return loaded;
  }
  const updated: HabitEntry = { ...loaded.value, enabled, updatedAt };
  await saveHabit(layout, updated);
  return { ok: true, value: updated };
}

/**
 * 删除条目：清理全部分类目录下同 id 的所有副本（含崩溃残留旧址），与 saveHabit
 * 的自愈语义对称。返回是否确实删除了至少一个文件（false = 本就不存在，幂等）。
 */
export async function deleteHabit(layout: HabitLayout, id: HabitEntryId): Promise<boolean> {
  if (!isFileNameSafeHabitId(id)) {
    throw new HabitEncodeError(
      `习惯条目 id 无法用作文件名（不允许控制字符、<>:"/\\|?* 与前导点）: ${id}`,
    );
  }
  let removed = false;
  for (const dir of allHabitDirs(layout)) {
    const filePath = join(dir, habitFileName(id));
    try {
      await rm(filePath);
      removed = true;
    } catch (error) {
      if (errnoCodeOf(error) === "ENOENT") {
        continue;
      }
      throw new StorageIoError(filePath, "删除习惯条目失败", { cause: error });
    }
  }
  return removed;
}

/** listHabits 的过滤条件。 */
export interface ListHabitsFilter {
  readonly category?: HabitCategory;
  readonly status?: MemoryStatus;
  readonly enabled?: boolean;
}

/** 扫描中被跳过的问题文件：路径 + typed error，供调用方上报（不阻断列表）。 */
export interface HabitEntryIssue {
  readonly path: string;
  readonly error: HabitEntryDecodeError | StorageIoError;
}

/** listHabits 的结果：合法条目 + 问题文件清单。 */
export interface ListHabitsResult {
  readonly entries: readonly HabitEntry[];
  readonly issues: readonly HabitEntryIssue[];
}

function compareForListing(a: HabitEntry, b: HabitEntry): number {
  if (a.updatedAt !== b.updatedAt) {
    return b.updatedAt - a.updatedAt;
  }
  if (a.id < b.id) {
    return -1;
  }
  return a.id > b.id ? 1 : 0;
}

/**
 * 列出条目：扫描全部分类目录，按 frontmatter 字段过滤。损坏 / 非法文件不阻断
 * 列表，进 issues。排序：updatedAt 降序，同刻按 id 升序（编译层 T5.2 会按
 * importance 重排，本层给稳定顺序即可）。
 */
export async function listHabits(
  layout: HabitLayout,
  filter: ListHabitsFilter = {},
): Promise<ListHabitsResult> {
  const byId = new Map<string, HabitEntry>();
  const issues: HabitEntryIssue[] = [];

  for (const dir of allHabitDirs(layout)) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (errnoCodeOf(error) === "ENOENT") {
        continue;
      }
      issues.push({
        path: dir,
        error: new StorageIoError(dir, "读取习惯目录失败", { cause: error }),
      });
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md") || name.startsWith(".")) {
        continue;
      }
      const filePath = join(dir, name);
      const read = await readText(filePath);
      if (!read.ok) {
        if (read.error.code !== "not-found") {
          issues.push({ path: filePath, error: read.error });
        }
        continue;
      }
      const decoded = decodeHabitEntryFile(read.value, filePath);
      if (!decoded.ok) {
        issues.push({ path: filePath, error: decoded.error });
        continue;
      }
      const entry = decoded.value;
      if (habitFileName(entry.id) !== name) {
        issues.push({
          path: filePath,
          error: new HabitEntryFieldError(
            filePath,
            "id",
            `frontmatter id「${entry.id}」与文件名不一致`,
          ),
        });
        continue;
      }
      const existing = byId.get(entry.id);
      if (existing === undefined || entry.updatedAt > existing.updatedAt) {
        byId.set(entry.id, entry);
      }
    }
  }

  const entries = [...byId.values()]
    .filter(
      (entry) =>
        (filter.category === undefined || entry.category === filter.category) &&
        (filter.status === undefined || entry.status === filter.status) &&
        (filter.enabled === undefined || entry.enabled === filter.enabled),
    )
    .sort(compareForListing);
  return { entries, issues };
}
