/** Agent Runtime 适配器（codex / claude / gemini / opencode / generic-exec，T2.x 落地）。 */
export * from "./auth-probe/index.js";

export const PACKAGE_NAME = "@ff-pane/adapters";

/**
 * 将文本按行切分（兼容 \n 与 \r\n），丢弃末尾空行。
 * 供后续 JSONL 事件流解析（技术选型 §4）复用。
 */
export function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}
