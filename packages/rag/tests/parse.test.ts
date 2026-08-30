/**
 * T6.1 解析器注册表单测：各格式样例文件解析 + 分发判定 + 失败隔离。
 * fixture 见 packages/rag/fixtures/parse/（二进制样例由同目录脚本生成，可复现）。
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BinaryContentError,
  decodeHtmlEntities,
  decodeTextFile,
  detectFormat,
  extractHtmlText,
  fileBaseName,
  fileExtension,
  isSupportedFile,
  MalformedDocumentError,
  normalizeText,
  ParseReadError,
  parseDocument,
  parseFile,
  parseFiles,
  SUPPORTED_EXTENSIONS,
  UnsupportedFormatError,
} from "../src/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/parse");

/** 取 fixture 的绝对路径。 */
function fixture(name: string): string {
  return join(FIXTURES, name);
}

describe("扩展名分发（formats）", () => {
  it("按扩展名判定格式，源码额外带语言", () => {
    expect(detectFormat("a/b/readme.md")).toEqual({ format: "markdown" });
    expect(detectFormat("notes.TXT")).toEqual({ format: "text" });
    expect(detectFormat("doc.pdf")).toEqual({ format: "pdf" });
    expect(detectFormat("report.docx")).toEqual({ format: "docx" });
    expect(detectFormat("page.HTM")).toEqual({ format: "html" });
    expect(detectFormat("src/main.ts")).toEqual({ format: "source_code", language: "typescript" });
    expect(detectFormat("app.py")).toEqual({ format: "source_code", language: "python" });
  });

  it("不支持的扩展名与隐藏文件判定为未知", () => {
    expect(detectFormat("archive.zip")).toBeUndefined();
    expect(detectFormat("image.png")).toBeUndefined();
    expect(detectFormat("Makefile")).toBeUndefined();
    // 开头的点是隐藏文件，不当扩展名
    expect(detectFormat(".gitignore")).toBeUndefined();
    expect(isSupportedFile("archive.zip")).toBe(false);
    expect(isSupportedFile("readme.md")).toBe(true);
  });

  it("扩展名与文件名取值兼容 Windows 反斜杠路径", () => {
    expect(fileExtension("D:\\docs\\指南.md")).toBe(".md");
    expect(fileBaseName("D:\\docs\\指南.md")).toBe("指南");
    expect(fileBaseName("/tmp/no-ext")).toBe("no-ext");
    expect(fileExtension("/tmp/no-ext")).toBe("");
  });

  it("支持的扩展名清单已排序且覆盖六类格式", () => {
    expect(SUPPORTED_EXTENSIONS).toEqual([...SUPPORTED_EXTENSIONS].sort());
    for (const ext of [".md", ".txt", ".pdf", ".docx", ".html", ".ts"]) {
      expect(SUPPORTED_EXTENSIONS).toContain(ext);
    }
  });
});

describe("文本解码（text）", () => {
  it("统一换行为 LF 并去除 BOM", () => {
    expect(normalizeText("\uFEFF# 标题\r\n正文\r更多")).toBe("# 标题\n正文\n更多");
  });

  it("CRLF 文件解码后不残留 \\r（Windows 下分块快照才能跨平台一致）", () => {
    const bytes = new TextEncoder().encode("第一行\r\n第二行\r\n");
    expect(decodeTextFile("a.txt", bytes)).toBe("第一行\n第二行\n");
  });

  it("含 NUL 字节的文件按二进制拒收", () => {
    const bytes = new Uint8Array([0x68, 0x69, 0x00, 0x01, 0x02]);
    expect(() => decodeTextFile("fake.txt", bytes)).toThrow(BinaryContentError);
  });

  it("非 UTF-8 编码（大量替换字符）拒收，避免乱码进索引", () => {
    // GBK 编码的中文字节序列，按 UTF-8 解码会产生大量 U+FFFD
    const gbk = new Uint8Array(64).fill(0xd6);
    expect(() => decodeTextFile("gbk.txt", gbk)).toThrow(BinaryContentError);
  });

  it("极短文件不因个别替换字符被误判", () => {
    const bytes = new Uint8Array([0xff, 0x41]);
    expect(() => decodeTextFile("tiny.txt", bytes)).not.toThrow();
  });
});

describe("HTML 正文抽取（html）", () => {
  it("解码命名与数字实体，未知实体原样保留", () => {
    expect(decodeHtmlEntities("a &lt; b &amp;&amp; c &gt; d")).toBe("a < b && c > d");
    expect(decodeHtmlEntities("&#x7B2C;&#19968;")).toBe("第一");
    expect(decodeHtmlEntities("&bogus; &amp;")).toBe("&bogus; &");
  });

  it("丢弃 script/style 内容，保留正文", () => {
    const text = extractHtmlText(
      "<div><style>p{color:red}</style><p>正文</p><script>var a = 1 > 0;</script></div>",
    );
    expect(text).toBe("正文");
    expect(text).not.toContain("color");
    expect(text).not.toContain("var a");
  });

  it("属性值内的 > 不被误判为标签结束", () => {
    expect(extractHtmlText('<p title="a > b">内容</p>')).toBe("内容");
  });

  it("块级标签转换为换行，单元格转换为空格", () => {
    // 相邻块级元素的收尾与起始各产出一次换行 → 空行，正是分块器要的段落边界
    expect(extractHtmlText("<p>一</p><p>二</p>")).toBe("一\n\n二");
    // 同一行的单元格用空格分隔，不制造假的段落边界
    expect(extractHtmlText("<tr><td>甲</td><td>乙</td></tr>")).toBe("甲 乙");
    // 连续空行最多压到一个（不会因嵌套块累积出大片空白）
    expect(extractHtmlText("<div><div><p>唯一段落</p></div></div>")).toBe("唯一段落");
  });

  it("<pre> 内保留原始空白，pre 外折叠空白", () => {
    const text = extractHtmlText("<p>a     b</p><pre>line1\n  line2</pre>");
    expect(text).toContain("a b");
    expect(text).toContain("line1\n  line2");
  });

  it("存在 <main> 时只取正文主体，丢弃导航与页脚", () => {
    const text = extractHtmlText(
      "<body><nav>导航</nav><main><p>主体</p></main><footer>页脚</footer></body>",
    );
    expect(text).toBe("主体");
  });

  it("无壳片段（mammoth 产出形态）同样可处理", () => {
    expect(extractHtmlText("<h1>标题</h1><p>段落</p>")).toBe("标题\n\n段落");
  });

  it("畸形输入不抛异常也不卡死（线性扫描，无正则回溯）", () => {
    expect(() => extractHtmlText("<<<>>><p<<<")).not.toThrow();
    expect(() => extractHtmlText(`${"<div ".repeat(5000)}x`)).not.toThrow();
    expect(() => extractHtmlText("<script>未闭合")).not.toThrow();
  });
});

describe("各格式 fixture 解析", () => {
  it("markdown：原文结构完整保留，交由分块器解析标题树", async () => {
    const document = await parseFile(fixture("sample.md"));
    expect(document.format).toBe("markdown");
    expect(document.title).toBe("sample");
    expect(document.text).toContain("# 知识库使用指南");
    expect(document.text).toContain("### Windows");
    expect(document.text).toContain("```bash");
    expect(document.pages).toBeUndefined();
    expect(document.text).not.toContain("\r");
  });

  it("text：纯文本原样读入", async () => {
    const document = await parseFile(fixture("sample.txt"));
    expect(document.format).toBe("text");
    expect(document.text).toContain("检索质量评测记录");
  });

  it("source_code：带语言标识供分块器选边界规则", async () => {
    const document = await parseFile(fixture("sample.ts"));
    expect(document.format).toBe("source_code");
    expect(document.language).toBe("typescript");
    expect(document.text).toContain("export function fuseRankings");
    expect(document.text).toContain("export class QueryPlanner");
  });

  it("html：抽出正文，剥离脚本样式与页脚", async () => {
    const document = await parseFile(fixture("sample.html"));
    expect(document.format).toBe("html");
    expect(document.text).toContain("混合检索");
    expect(document.text).toContain("双路召回");
    // <main> 之外的导航/页脚不进正文
    expect(document.text).not.toContain("版权所有");
    expect(document.text).not.toContain("首页");
    // script/style 内容不进正文
    expect(document.text).not.toContain("analytics");
    expect(document.text).not.toContain("sans-serif");
    // 实体已解码
    expect(document.text).toContain("第一名得分为 1/61 < 1/60");
    // 表格单元不粘连
    expect(document.text).toContain("BM25 永远可用");
    // pre 内 SQL 保留换行
    expect(document.text).toContain("SELECT rowid, bm25(chunk_fts)\nFROM chunk_fts");
  });

  it("docx：经 mammoth → HTML → 纯文本，保住标题与段落块边界", async () => {
    const document = await parseFile(fixture("sample.docx"));
    expect(document.format).toBe("docx");
    expect(document.title).toBe("sample");
    const lines = document.text.split("\n").filter((line) => line !== "");
    expect(lines[0]).toBe("知识库验收记录");
    expect(lines).toContain("导入范围");
    expect(document.text).toContain("单文件失败被隔离");
  });

  it("pdf：逐页正文 + 页码，标题取自元数据", async () => {
    const document = await parseFile(fixture("sample.pdf"));
    expect(document.format).toBe("pdf");
    expect(document.title).toBe("Hybrid Retrieval Notes");
    expect(document.pages).toHaveLength(2);
    expect(document.pages?.[0]?.page).toBe(1);
    expect(document.pages?.[0]?.text).toContain("Hybrid Retrieval Notes");
    expect(document.pages?.[1]?.page).toBe(2);
    expect(document.pages?.[1]?.text).toContain("provenance");
    // 全文 = 各页拼接
    expect(document.text).toContain("reciprocal rank fusion");
    expect(document.text).toContain("page number");
  });

  it("pdf：解析不改动调用方传入的字节（pdfjs 会就地写缓冲区）", async () => {
    const bytes = await readFile(fixture("sample.pdf"));
    const snapshot = Uint8Array.from(bytes);
    await parseDocument({ filePath: fixture("sample.pdf"), bytes });
    expect(Uint8Array.from(bytes)).toEqual(snapshot);
  });
});

describe("注册表分发与错误处理", () => {
  it("显式指定格式可跳过扩展名判定（会话收录 / 手动条目）", async () => {
    const bytes = new TextEncoder().encode("# 来自会话的笔记");
    const document = await parseDocument({
      filePath: "note-01",
      bytes,
      format: "markdown",
    });
    expect(document.format).toBe("markdown");
    expect(document.title).toBe("note-01");
  });

  it("不支持的扩展名抛 UnsupportedFormatError 并携带扩展名", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(parseDocument({ filePath: "a.zip", bytes })).rejects.toThrow(
      UnsupportedFormatError,
    );
    await expect(parseDocument({ filePath: "a.zip", bytes })).rejects.toMatchObject({
      code: "unsupported-format",
      extension: ".zip",
    });
  });

  it("损坏的 PDF / docx 抛 MalformedDocumentError 而非崩溃", async () => {
    const junk = new TextEncoder().encode("这不是一个合法的文档包");
    await expect(parseDocument({ filePath: "broken.pdf", bytes: junk })).rejects.toThrow(
      MalformedDocumentError,
    );
    await expect(parseDocument({ filePath: "broken.docx", bytes: junk })).rejects.toThrow(
      MalformedDocumentError,
    );
  });

  it("文件不存在抛 ParseReadError", async () => {
    await expect(parseFile(fixture("不存在的文件.md"))).rejects.toThrow(ParseReadError);
  });
});

describe("批量解析：单文件失败不中断批量", () => {
  it("失败个体降级为记录，其余照常产出，且失败原因可分类", async () => {
    const unsupported = fixture("archive.zip"); // 扩展名不支持
    const missing = fixture("缺失.txt"); // 支持但文件不存在
    const outcomes = await parseFiles([
      fixture("sample.md"),
      unsupported,
      missing,
      fixture("sample.txt"),
    ]);

    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, false, false, true]);

    // 失败记录必须带得走可分类的诊断信息（导入结果页要按原因归类展示）
    const [, unsupportedOutcome, missingOutcome] = outcomes;
    expect(unsupportedOutcome).toMatchObject({
      ok: false,
      filePath: unsupported,
      error: { code: "unsupported-format" },
    });
    expect(missingOutcome).toMatchObject({
      ok: false,
      filePath: missing,
      error: { code: "read-error" },
    });
  });

  it("逐个上报进度，计数含失败项", async () => {
    const progress: Array<{ done: number; total: number; ok: boolean }> = [];
    await parseFiles([fixture("sample.md"), fixture("bad.zip")], {
      onProgress: (done, total, outcome) => {
        progress.push({ done, total, ok: outcome.ok });
      },
    });
    expect(progress).toEqual([
      { done: 1, total: 2, ok: true },
      { done: 2, total: 2, ok: false },
    ]);
  });

  it("取消信号生效：停止取新文件，已完成结果照常返回", async () => {
    const controller = new AbortController();
    const outcomes = await parseFiles([fixture("sample.md"), fixture("sample.txt")], {
      signal: controller.signal,
      onProgress: () => {
        controller.abort();
      },
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.ok).toBe(true);
  });

  it("空清单返回空结果", async () => {
    expect(await parseFiles([])).toEqual([]);
  });
});
