/**
 * Unified diff 行分类（W3.7）：纯逻辑，可单测。
 * 设计系统 §3.5：diff 正文一律 text-fg + font-mono（不染色），增删语义由行首标记 +
 * 行底色双重承载（色盲可读）。本函数只判定行类型，着色映射在 DiffView。
 */

export type DiffLineKind = "added" | "removed" | "hunk" | "meta" | "context";

/** 判定一行 unified diff 属于哪一类。 */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("@@")) {
    return "hunk";
  }
  // 文件头：+++ / --- / diff / index / new file / deleted file / rename …
  if (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("rename ") ||
    line.startsWith("similarity ")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) {
    return "added";
  }
  if (line.startsWith("-")) {
    return "removed";
  }
  return "context";
}
