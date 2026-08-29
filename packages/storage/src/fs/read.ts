/**
 * 安全读（W1.2a）：readText / readJson。
 *
 * 与原子写对偶的读取侧约定：
 * - 不抛裸异常：一切失败以 FsResult 判别联合返回（文件不存在是常态分支）。
 * - JSON 损坏不崩溃、不静默：原文件重命名隔离为 `<原名>.corrupt-<时间戳>`，
 *   返回携带原始解析错误的 StorageCorruptJsonError；下次读取得到干净的 not-found，
 *   调用方可按「首次初始化」路径重建，用户可从隔离文件人工抢救内容。
 */

import { readFile, rename } from "node:fs/promises";
import {
  errnoCodeOf,
  type FsResult,
  type ReadJsonError,
  type ReadTextError,
  StorageCorruptJsonError,
  StorageIoError,
  StorageNotFoundError,
} from "./errors.js";

/** readText 的结果类型。 */
export type ReadTextResult = FsResult<string, ReadTextError>;

/** readJson 的结果类型。泛型 T 由调用方声明（结构校验归 W1.2b/c 等上层工单）。 */
export type ReadJsonResult<T> = FsResult<T, ReadJsonError>;

/**
 * 剥离开头的 UTF-8 BOM。设计文档 §8.4 允许用户用任意编辑器直改数据文件，
 * Windows 记事本等编辑器保存时可能引入 BOM；写入侧永远不产生 BOM。
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 读取 UTF-8 文本。文件不存在返回 not-found 结果，其余故障返回 io-error 结果。 */
export async function readText(filePath: string): Promise<ReadTextResult> {
  try {
    const raw = await readFile(filePath, "utf8");
    return { ok: true, value: stripBom(raw) };
  } catch (error) {
    if (errnoCodeOf(error) === "ENOENT") {
      return { ok: false, error: new StorageNotFoundError(filePath) };
    }
    return { ok: false, error: new StorageIoError(filePath, "读取文件失败", { cause: error }) };
  }
}

/** 生成文件名安全的隔离时间戳（ISO 8601，冒号与小数点替换为连字符）。 */
function quarantineTimestamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}

/**
 * 读取并解析 JSON 文件。
 * 解析失败时执行损坏隔离（见模块注释）；隔离动作本身失败（极端：目录只读）
 * 则降级为 io-error 结果，原文件原地保留，同样不抛异常。
 */
export async function readJson<T = unknown>(filePath: string): Promise<ReadJsonResult<T>> {
  const textResult = await readText(filePath);
  if (!textResult.ok) {
    return textResult;
  }
  try {
    return { ok: true, value: JSON.parse(textResult.value) as T };
  } catch (parseError) {
    const quarantinePath = `${filePath}.corrupt-${quarantineTimestamp()}`;
    try {
      await rename(filePath, quarantinePath);
    } catch (renameError) {
      return {
        ok: false,
        error: new StorageIoError(filePath, "JSON 损坏且隔离失败", { cause: renameError }),
      };
    }
    const reason = parseError instanceof Error ? parseError.message : String(parseError);
    return {
      ok: false,
      error: new StorageCorruptJsonError(filePath, quarantinePath, reason, { cause: parseError }),
    };
  }
}
