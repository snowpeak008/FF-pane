/** Markdown 读写 + SQLite 索引维护（T1.2 / T1.3 落地）。 */
export const PACKAGE_NAME = "@ff-pane/storage";

export * from "./index-db/index.js";

/**
 * 将 Windows 风格路径分隔符统一为 POSIX 正斜杠。
 * 用于存储层内部路径归一化（开发计划 §12 风险 R5：Windows 中文路径全链路 UTF-8）。
 */
export function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

export * from "./fs/index.js";

export * from "./memory/index.js";
export * from "./profiles/index.js";
export * from "./providers/index.js";

export * from "./records/index.js";
