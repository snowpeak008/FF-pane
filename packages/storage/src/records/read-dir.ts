/**
 * records 内部目录列举辅助（W1.2b，不经 barrel 导出）。
 * 目录不存在视同空集合（布局尚未初始化 = 尚无记录，属常态而非故障）。
 */

import { readdir } from "node:fs/promises";
import { errnoCodeOf, StorageIoError } from "../fs/index.js";
import type { RecordResult } from "./errors.js";

/** 列出目录下全部条目名（不含路径）。目录缺失返回空数组，其余故障返回 io-error 结果。 */
export async function readDirNames(dirPath: string): Promise<RecordResult<readonly string[]>> {
  try {
    return { ok: true, value: await readdir(dirPath) };
  } catch (error) {
    if (errnoCodeOf(error) === "ENOENT") {
      return { ok: true, value: [] };
    }
    return { ok: false, error: new StorageIoError(dirPath, "读取目录失败", { cause: error }) };
  }
}
