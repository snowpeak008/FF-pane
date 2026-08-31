/**
 * 知识库导出（T6.5，§8.3.6「选中条目 / 整个来源目录 → Markdown 文件（含出处元数据）」）。
 *
 * 两处决定：
 *
 * 1. **元数据走 YAML frontmatter，键名用英文**。导出文件是要被别的工具（编辑器、
 *    静态站点、另一套 RAG）吃掉的产物，不是界面文案；键名跟着界面语言变就没法
 *    被程序稳定读取了。这也与本仓记忆 / 习惯的 Markdown 落盘格式一致。
 *
 * 2. **块之间用 HTML 注释标出出处而不是标题**。出处（标题路径 / 页码）是关于正文的
 *    元信息，若渲染成 `### 第 3 页` 就会与文档自身的标题层级混在一起，导出的文件
 *    重新导入时会多出一层不存在的结构。注释在任何 Markdown 渲染器里都不可见，
 *    而 grep 得到。
 */

import type { KnowledgeChunk, KnowledgeEntry } from "@ff-pane/shared";

/** 一个待导出的条目：条目本体 + 它的全部块（按 seq 升序）。 */
export interface KnowledgeExportItem {
  readonly entry: KnowledgeEntry;
  readonly chunks: readonly KnowledgeChunk[];
}

/** YAML 里必须靠引号才能安全表达的形状（行首指示符、`: ` 与 ` #` 的歧义、换行）。 */
const YAML_NEEDS_QUOTES = /^$|^\s|\s$|^[-?:,[\]{}#&*!|>'"%@`]|:\s|\s#|[\n\r]/;

/**
 * YAML 标量：只在必要时加引号。
 * **不用 `\w` 判「安全字符」**——JS 的 `\w` 只认 ASCII，中文标签会被整串套上引号，
 * 导出文件看着像转义事故。反过来只挑真正会让 YAML 解析歧义的形状加引号，
 * 于是 `D:/docs/a.md` 与 `架构` 都能原样躺在文件里。
 */
function yamlScalar(value: string): string {
  return YAML_NEEDS_QUOTES.test(value) ? JSON.stringify(value) : value;
}

/** 条目来源的单行表达（file_import 给路径，session_capture 给会话，manual 无）。 */
function originLine(entry: KnowledgeEntry): string | undefined {
  switch (entry.origin.kind) {
    case "file_import":
      return `source: ${yamlScalar(entry.origin.sourcePath)}`;
    case "session_capture":
      return `sourceSession: ${yamlScalar(entry.origin.sessionId)}`;
    default:
      return undefined;
  }
}

/** 一个块的出处注释；无标题路径也无页码时不产出注释行。 */
function provenanceComment(chunk: KnowledgeChunk): string | undefined {
  const parts: string[] = [`chunk ${chunk.seq}`];
  const heading = chunk.provenance.headingPath;
  if (heading !== undefined && heading.length > 0) {
    parts.push(heading.join(" > "));
  }
  if (chunk.provenance.page !== undefined) {
    parts.push(`p.${chunk.provenance.page}`);
  }
  return `<!-- ${parts.join(" · ")} -->`;
}

/** 单个条目的 Markdown 片段。 */
function entryToMarkdown(item: KnowledgeExportItem): string {
  const { entry } = item;
  const front = [
    "---",
    `title: ${yamlScalar(entry.title)}`,
    `format: ${entry.format}`,
    `origin: ${entry.origin.kind}`,
    originLine(entry),
    `importedAt: ${new Date(entry.importedAt).toISOString()}`,
    entry.tags === undefined || entry.tags.length === 0
      ? undefined
      : `tags: [${entry.tags.map(yamlScalar).join(", ")}]`,
    "---",
  ].filter((line): line is string => line !== undefined);

  const body = item.chunks.map((chunk) => `${provenanceComment(chunk)}\n\n${chunk.text.trim()}`);
  return [...front, "", `# ${entry.title}`, "", ...body].join("\n");
}

/**
 * 多个条目 → 单个 Markdown 文件正文。
 * 条目之间用水平线分隔：导出是一份「合集」，读的人需要一眼看出边界在哪。
 * 纯函数（除 ISO 时间格式化外无外部依赖），故可直接单测。
 */
export function entriesToMarkdown(items: readonly KnowledgeExportItem[]): string {
  return `${items.map(entryToMarkdown).join("\n\n---\n\n")}\n`;
}
