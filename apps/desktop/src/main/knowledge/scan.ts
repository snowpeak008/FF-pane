/**
 * 导入路径展开（T6.5）：把用户选的「若干文件 + 若干目录」摊平成一份确定的待导入文件清单。
 *
 * 三处需要交代的决定：
 *
 * 1. **跳过目录一律硬编码在这里，而不是做成设置**。用户把一个代码仓库整个拖进来
 *    是最自然的用法，而 `node_modules` / `.git` 里躺着的东西没有一样是他想检索的
 *    ——十万级块的容量目标（§8.3.2）会被这两个目录一次吃光。做成可配置只是把
 *    「必然要跳过」的判断推给用户。
 *
 * 2. **不跟随符号链接**。`Dirent.isDirectory()` 对目录软链返回 false，于是软链天然
 *    不被递归——这正是我们要的：跟随会撞上环，也会把同一份内容索引两遍。
 *
 * 3. **结果去重并按路径排序**。导入的顺序决定条目的写入顺序，进而决定进度条的推进
 *    次序；确定的顺序让「同样的输入两次导入」产生同样的过程，出问题时可复现。
 */

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isSupportedFile } from "@ff-pane/rag";

/**
 * 递归时整棵跳过的目录名（小写比较）。
 * 点开头的目录（.git / .venv / .workbench …）统一按前缀跳过，见 shouldSkipDirectory。
 */
const SKIPPED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "__pycache__",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
]);

/** 该目录是否整棵跳过。 */
export function shouldSkipDirectory(name: string): boolean {
  return name.startsWith(".") || SKIPPED_DIRECTORY_NAMES.has(name.toLowerCase());
}

/** 扫描选项。 */
export interface CollectImportFilesOptions {
  /** 取消信号：中途取消时立即停止遍历并抛 AbortError 之外的自定义中止（见 aborted）。 */
  readonly signal?: AbortSignal;
  /** 每发现一个候选文件回调一次（供 scanning 阶段的进度显示）。 */
  readonly onFound?: (count: number) => void;
  /** 上限：达到即停止扫描（防止误选根目录时无止境地走下去）。 */
  readonly maxFiles?: number;
}

/**
 * 单次导入的文件数上限。
 * 不是性能上限而是**误操作护栏**：选中 C:\ 或 / 的代价是几十分钟的静默遍历，
 * 到了上限就收手并如实上报「扫描被截断」，比让用户盯着不动的进度条强。
 */
export const MAX_IMPORT_FILES = 20_000;

/** 扫描结果。 */
export interface CollectImportFilesResult {
  /** 待导入文件的绝对路径（去重 + 升序）。 */
  readonly files: readonly string[];
  /** 是否因达到上限而截断（界面须如实提示，不能装作扫全了）。 */
  readonly truncated: boolean;
}

/**
 * 展开导入路径。单个路径不可访问（已删除 / 无权限）不中断整批——
 * 与 T6.1 的 parseFiles 同一条纪律，它会在后续解析阶段以失败条目现身。
 */
export async function collectImportFiles(
  paths: readonly string[],
  options: CollectImportFilesOptions = {},
): Promise<CollectImportFilesResult> {
  const limit = options.maxFiles ?? MAX_IMPORT_FILES;
  const found = new Set<string>();
  let truncated = false;
  // 经函数读取而不是直接看 options.signal.aborted：aborted 是只读属性，
  // TS 会把第一次检查的结果一路窄化下去，后续的检查就成了「恒为 false」的死代码
  const aborted = (): boolean => options.signal?.aborted === true;

  const add = (filePath: string): void => {
    if (found.size >= limit) {
      truncated = true;
      return;
    }
    if (!isSupportedFile(filePath)) {
      return;
    }
    const before = found.size;
    found.add(resolve(filePath));
    if (found.size !== before) {
      options.onFound?.(found.size);
    }
  };

  const walk = async (dir: string): Promise<void> => {
    if (aborted() || found.size >= limit) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // 不可读的子目录跳过：一次导入不该因为一个受限目录整体失败
      return;
    }
    // 目录项顺序随文件系统而变，先排序让遍历过程本身也是确定的
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of sorted) {
      if (aborted() || found.size >= limit) {
        truncated = truncated || found.size >= limit;
        return;
      }
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name)) {
          await walk(join(dir, entry.name));
        }
      } else if (entry.isFile()) {
        add(join(dir, entry.name));
      }
    }
  };

  for (const path of paths) {
    if (aborted()) {
      break;
    }
    let isDirectory: boolean;
    try {
      isDirectory = (await stat(path)).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory) {
      await walk(resolve(path));
    } else {
      // 用户显式点选的单个文件不做扩展名过滤之外的判断——他知道自己选了什么
      add(path);
    }
  }

  return { files: [...found].sort(), truncated };
}
