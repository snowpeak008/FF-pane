/**
 * 原子写基础设施（W1.2a）：同目录临时文件 + rename 覆盖。
 *
 * 保证：目标文件在任何时刻只呈现「完整旧内容」或「完整新内容」，
 * 崩溃 / 断电最坏情况只留下临时残片（`.<原名>.<uuid>.tmp`），不污染目标文件。
 * 编码统一 UTF-8 无 BOM（开发计划 §12 风险 R5：全链路 UTF-8）。
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { errnoCodeOf, StorageFsError, StorageIoError } from "./errors.js";

/** 幂等创建目录（含缺失的所有父级）。失败抛 StorageIoError。 */
export async function ensureDir(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true });
  } catch (error) {
    throw new StorageIoError(dirPath, "创建目录失败", { cause: error });
  }
}

/**
 * Windows 上 rename 覆盖已存在目标偶发瞬时失败（目标被句柄或杀软短暂占用，
 * 表现为 EPERM/EACCES/EBUSY）时的重试间隔（毫秒；首次立即执行）。
 */
const RENAME_RETRY_DELAYS_MS = [0, 20, 100] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isTransientRenameError(error: unknown): boolean {
  const code = errnoCodeOf(error);
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

/**
 * rename 覆盖目标文件。POSIX rename 天然覆盖；Windows 上 Node 的 rename 走
 * MoveFileExW(MOVEFILE_REPLACE_EXISTING)，常规情况同样直接覆盖（tests/fs.test.ts
 * 「原子写覆盖旧文件」用例在 Windows 实测锁定该语义）。目标被占用抛出瞬时错误时
 * 短暂重试；仍失败则回退为「删除目标 + rename」，两步窗口极小且新内容已完整落盘。
 */
async function renameOverwrite(sourcePath: string, targetPath: string): Promise<void> {
  let lastError: unknown;
  for (const delayMs of RENAME_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    try {
      await rename(sourcePath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientRenameError(error)) {
        break;
      }
    }
  }
  try {
    await rm(targetPath, { force: true });
    await rename(sourcePath, targetPath);
  } catch (fallbackError) {
    throw new StorageIoError(targetPath, "原子写 rename 覆盖目标失败", {
      cause: fallbackError ?? lastError,
    });
  }
}

/**
 * 原子写文本文件（UTF-8 无 BOM）。
 * 流程：同目录临时文件 → 写入 → fsync 落盘 → rename 覆盖目标。
 * 父目录缺失时自动补建；任何失败清理临时文件后抛 StorageFsError 子类。
 */
export async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await ensureDir(dir);
  const tempPath = join(dir, `.${basename(filePath)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(tempPath, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameOverwrite(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    if (error instanceof StorageFsError) {
      throw error;
    }
    throw new StorageIoError(filePath, "原子写入失败", { cause: error });
  }
}

/**
 * 原子写 JSON 文件：2 空格缩进 + 结尾换行，便于用户用任意编辑器直接查看与
 * 修改、并获得干净的 Git diff（设计文档 §8.4 存储原则）。
 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const text: string | undefined = JSON.stringify(value, null, 2);
  if (text === undefined) {
    throw new StorageIoError(filePath, "值无法序列化为 JSON（undefined、函数等非 JSON 值）");
  }
  await writeTextAtomic(filePath, `${text}\n`);
}
