/**
 * 单个 Markdown 文件名。拒绝路径、`..` 和其它扩展名（含 .lnk / .exe）。
 * 主进程打开与索引解析共用，避免把索引里的字符串原样拼进路径。
 */

export function isSingleMarkdownFileName(name: string): boolean {
  if (name.length === 0 || name.length > 240) {
    return false;
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return false;
  }
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return false;
    }
  }
  return name.toLowerCase().endsWith(".md");
}
