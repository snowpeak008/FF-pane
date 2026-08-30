/**
 * 扩展名 → 格式分发表（技术选型 §8「解析器注册表（按扩展名分发）」）。
 *
 * 这是「支持哪些文件」的唯一事实来源：注册表按本表选解析器，
 * 批量导入的文件筛选（T6.5 导入目录时跳过不支持的文件）也复用本表。
 * source_code 额外带 language，供 T6.2 的函数/类边界启发式选规则。
 */

import type { KnowledgeFormat } from "@ff-pane/shared";

/** 一个扩展名的判定结果。 */
export interface FormatDescriptor {
  /** 领域格式（决定解析器与分块策略）。 */
  readonly format: KnowledgeFormat;
  /** 仅 source_code：语言标识。 */
  readonly language?: string;
}

/** 源码扩展名 → 语言标识。语言名用于 T6.2 挑选边界规则，取通用小写名。 */
const SOURCE_CODE_LANGUAGES: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".scala": "scala",
  ".sh": "shell",
  ".bash": "shell",
  ".ps1": "powershell",
  ".sql": "sql",
  ".vue": "vue",
  ".svelte": "svelte",
};

/** 非源码扩展名 → 格式。 */
const PLAIN_FORMATS: Readonly<Record<string, KnowledgeFormat>> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "markdown",
  ".txt": "text",
  ".text": "text",
  ".log": "text",
  ".csv": "text",
  ".json": "text",
  ".yaml": "text",
  ".yml": "text",
  ".toml": "text",
  ".ini": "text",
  ".pdf": "pdf",
  ".docx": "docx",
  ".html": "html",
  ".htm": "html",
  ".xhtml": "html",
};

/**
 * 取路径的小写扩展名（含点）。无扩展名返回空串。
 * 手写而不用 node:path.extname：本模块保持零 Node 依赖，可在任意环境复用。
 */
export function fileExtension(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const base = filePath.slice(lastSlash + 1);
  const lastDot = base.lastIndexOf(".");
  // 开头的点是隐藏文件（.gitignore），不算扩展名
  if (lastDot <= 0) {
    return "";
  }
  return base.slice(lastDot).toLowerCase();
}

/** 取路径的文件名（不含扩展名），作为条目默认标题。 */
export function fileBaseName(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const base = filePath.slice(lastSlash + 1);
  const ext = fileExtension(filePath);
  return ext === "" ? base : base.slice(0, base.length - ext.length);
}

/**
 * 按扩展名判定格式。不支持的扩展名返回 undefined
 * （由调用方决定是抛 UnsupportedFormatError 还是在批量导入时静默跳过）。
 */
export function detectFormat(filePath: string): FormatDescriptor | undefined {
  const ext = fileExtension(filePath);
  const plain = PLAIN_FORMATS[ext];
  if (plain !== undefined) {
    return { format: plain };
  }
  const language = SOURCE_CODE_LANGUAGES[ext];
  if (language !== undefined) {
    return { format: "source_code", language };
  }
  return undefined;
}

/** 该扩展名是否受支持（T6.5 批量导入筛选文件用）。 */
export function isSupportedFile(filePath: string): boolean {
  return detectFormat(filePath) !== undefined;
}

/** 全部受支持的扩展名（含点，已排序）——界面上的文件选择过滤器用。 */
export const SUPPORTED_EXTENSIONS: readonly string[] = Object.freeze(
  [...Object.keys(PLAIN_FORMATS), ...Object.keys(SOURCE_CODE_LANGUAGES)].sort(),
);
