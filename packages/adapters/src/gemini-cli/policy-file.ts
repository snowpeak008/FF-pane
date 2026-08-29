/**
 * 每 Run 策略文件的落盘与清理（W2.5）。
 *
 * 三条约束：
 * 1. **写系统临时目录、用完即删**：策略内容由权限信封编译而来，属 Run 级临时事实，
 *    不该落进项目目录（会被 Agent 自己读到、也会污染 git 工作树）。
 * 2. **必须以 `.toml` 结尾**：`readPolicyFiles()` 对文件路径只接受 `.toml` 后缀
 *    （0.57.0 源码），后缀错了会被静默忽略——那等于权限规则整体失效，属高危静默失败。
 * 3. **路径不得含逗号**：`--policy` 是逗号分隔的数组选项（`coerceCommaSeparated`），
 *    含逗号的路径会被拆成两个不存在的路径，同样静默失效，故直接快速失败。
 *
 * 同步创建（mkdtempSync/writeFileSync）是刻意的：AgentAdapter.startTurn 必须同步返回
 * 句柄，策略文件是启动参数的一部分，不能等异步 IO。文件仅数 KB，同步写无实际开销。
 */

/// <reference types="node" />

import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 临时目录前缀（排障时按此前缀可在 %TEMP% 里定位残留）。 */
export const GEMINI_POLICY_DIR_PREFIX = "ff-pane-gemini-policy-";

/** 策略文件名。 */
export const GEMINI_POLICY_FILE_NAME = "ff-pane-run.toml";

/** 策略文件装配失败（属装配错误，由适配器转为 end(failed) 上交，不抛给调用方）。 */
export class GeminiPolicyFileError extends Error {
  override readonly name = "GeminiPolicyFileError";
}

/** 已落盘的策略文件句柄。 */
export interface GeminiPolicyFile {
  /** 传给 `--policy` 的文件绝对路径。 */
  readonly path: string;
  /** 删除文件与其临时目录；幂等，失败静默（临时目录残留不该拖垮一轮任务）。 */
  remove(): Promise<void>;
}

/** 落盘选项。 */
export interface GeminiPolicyFileOptions {
  /** 临时目录父目录，默认 os.tmpdir()（测试可注入）。 */
  readonly dir?: string;
  /** 保留文件不删（仅排障用；默认 false = 用完即删）。 */
  readonly keep?: boolean;
}

/** 写入策略文件。 */
export function writeGeminiPolicyFile(
  toml: string,
  options: GeminiPolicyFileOptions = {},
): GeminiPolicyFile {
  let directory: string;
  try {
    directory = mkdtempSync(join(options.dir ?? tmpdir(), GEMINI_POLICY_DIR_PREFIX));
  } catch (error) {
    throw new GeminiPolicyFileError(
      `无法在临时目录创建 Gemini 策略目录：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const path = join(directory, GEMINI_POLICY_FILE_NAME);
  if (path.includes(",")) {
    throw new GeminiPolicyFileError(
      `策略文件路径含逗号，会被 --policy 的逗号分隔解析拆断：${path}`,
    );
  }
  try {
    writeFileSync(path, toml, "utf8");
  } catch (error) {
    throw new GeminiPolicyFileError(
      `无法写入 Gemini 策略文件：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let removed = false;
  return {
    path,
    remove: async (): Promise<void> => {
      if (removed || options.keep === true) {
        return;
      }
      removed = true;
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
