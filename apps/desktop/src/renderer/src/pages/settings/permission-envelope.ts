/**
 * 权限信封编辑的纯逻辑（W3.2b）：路径列表 ↔ 多行文本互转。无 React 依赖，可单测。
 * 路径为相对项目根的 glob，一行一条（设计文档 §7）。
 */

/** 多行文本 → 路径数组：按行拆、去首尾空白、丢空行、去重（保序）。 */
export function parsePathLines(text: string): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

/** 路径数组 → 多行文本（一行一条）。 */
export function formatPathLines(paths: readonly string[]): string {
  return paths.join("\n");
}
