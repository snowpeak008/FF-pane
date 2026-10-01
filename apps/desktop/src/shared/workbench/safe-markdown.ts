/**
 * 不可信 Markdown 的安全子集。
 * 只产出纯文本块，调用方用文本节点渲染：不解析 HTML，不生成图片或链接元素，因此不会执行脚本或加载远程资源。
 */

export type SafeMarkdownBlock =
  | { readonly type: "heading"; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly type: "paragraph"; readonly text: string }
  | { readonly type: "code"; readonly text: string }
  | { readonly type: "list"; readonly items: readonly string[] }
  | { readonly type: "quote"; readonly text: string };

const MAX_BLOCKS = 400;

/** 图片与链接收成纯文本，远程地址只作为文字留下。 */
export function flattenInline(source: string): string {
  return source
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
}

export function parseSafeMarkdown(source: string): readonly SafeMarkdownBlock[] {
  const text = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n");
  const blocks: SafeMarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length && blocks.length < MAX_BLOCKS) {
    const line = lines[index] ?? "";
    if (line.startsWith("```")) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = heading[1]?.length === 1 ? 1 : heading[1]?.length === 2 ? 2 : 3;
      blocks.push({ type: "heading", level, text: flattenInline(heading[2] ?? "") });
      index += 1;
      continue;
    }
    if (line.startsWith(">")) {
      const body: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith(">")) {
        body.push((lines[index] ?? "").replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", text: flattenInline(body.join("\n")) });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] ?? "")) {
        items.push(flattenInline((lines[index] ?? "").replace(/^\s*[-*]\s+/, "")));
        index += 1;
      }
      blocks.push({ type: "list", items });
      continue;
    }
    const body: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? "").trim().length > 0 &&
      !/^(#{1,3})\s+/.test(lines[index] ?? "") &&
      !(lines[index] ?? "").startsWith("```") &&
      !(lines[index] ?? "").startsWith(">") &&
      !/^\s*[-*]\s+/.test(lines[index] ?? "")
    ) {
      body.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({ type: "paragraph", text: flattenInline(body.join("\n")) });
  }
  return blocks;
}
