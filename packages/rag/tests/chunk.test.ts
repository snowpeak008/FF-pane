/**
 * T6.2 结构感知分块器单测：token 估算 / 切点 / 各格式分段 / 打包与重叠 / 快照。
 * 快照基于 T6.1 的 parse fixture，端到端走「解析 → 分块」整条链路。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KnowledgeChunkId, KnowledgeEntryId } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import type { ChunkDocumentOptions, ChunkDraft, ParsedDocument, Segment } from "../src/index.js";
import {
  atomize,
  chunkDocument,
  DEFAULT_CHUNKING_PARAMS,
  estimateTokens,
  packSegments,
  parseFile,
  segmentCode,
  segmentDocument,
  segmentMarkdown,
  sliceByTokenBudget,
  splitByTokens,
  splitParagraphs,
  takeHead,
  takeTail,
  toKnowledgeChunks,
} from "../src/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/parse");

/** 造一句约 20 token 的中文，句号结尾便于验证断句切点。 */
function sentence(index: number): string {
  return `第${index}句：混合检索把关键词召回与向量召回合起来排序，这是第 ${index} 条验证语料。`;
}

/** 造一个由 count 句组成的段落。 */
function paragraph(count: number, offset = 0): string {
  return Array.from({ length: count }, (_, index) => sentence(offset + index)).join("");
}

/** 构造 ParsedDocument（只填分块器会读的字段）。 */
function documentOf(
  partial: Partial<ParsedDocument> & Pick<ParsedDocument, "format">,
): ParsedDocument {
  return { title: "t", text: "", ...partial };
}

const OPTIONS: ChunkDocumentOptions = { filePath: "D:\\docs\\样例.md" };

describe("token 估算（tokens）", () => {
  it("中文按一字一 token，英文按四字符一 token", () => {
    expect(estimateTokens("检索")).toBe(2);
    // 8 个非空白字符 → 2 token
    expect(estimateTokens("abcd efgh")).toBe(2);
    expect(estimateTokens("检索 hybrid")).toBe(2 + Math.ceil(6 / 4));
  });

  it("空白与控制符不单独计费，空串为 0", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("   \n\t  ")).toBe(0);
    expect(estimateTokens("a b")).toBe(estimateTokens("ab"));
  });

  it("扩展区汉字（代理对）按一字一 token，不被算成两个", () => {
    // U+20000 CJK 扩展 B 首字
    expect(estimateTokens("\u{20000}")).toBe(1);
    expect(estimateTokens("\u{20000}\u{20001}")).toBe(2);
  });

  it("估算随文本单调不减（打包层的容量判断依赖这一点）", () => {
    let previous = 0;
    let text = "";
    for (let index = 0; index < 20; index += 1) {
      text += sentence(index);
      const current = estimateTokens(text);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});

describe("切点（split）", () => {
  it("原子化后每个原子都不超预算，且拼回原文", () => {
    const text = `${paragraph(6)}\n${paragraph(6, 100)}`;
    const atoms = atomize(text, 12);
    expect(atoms.join("")).toBe(text);
    for (const atom of atoms) {
      expect(estimateTokens(atom)).toBeLessThanOrEqual(12);
    }
  });

  it("超长段落按行/句切成不超预算的片", () => {
    const pieces = splitByTokens(paragraph(30), 60);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(estimateTokens(piece)).toBeLessThanOrEqual(60);
    }
    // 切点落在句末：除末片外每片都以句号收尾
    for (const piece of pieces.slice(0, -1)) {
      expect(piece.endsWith("。")).toBe(true);
    }
  });

  it("takeHead 取头部剩尾部，两段合起来仍是原文的全部内容", () => {
    const text = paragraph(10);
    const [head, tail] = takeHead(text, 40);
    expect(head).toBeDefined();
    expect(tail).toBeDefined();
    expect(estimateTokens(head ?? "")).toBeLessThanOrEqual(40);
    expect(`${head ?? ""}${tail ?? ""}`).toBe(text);
  });

  it("takeTail 取的是原文后缀且不超预算", () => {
    const text = paragraph(10);
    const tail = takeTail(text, 40);
    expect(tail).not.toBe("");
    expect(text.endsWith(tail)).toBe(true);
    expect(estimateTokens(tail)).toBeLessThanOrEqual(40);
  });

  it("预算为零时 takeHead / takeTail 不取任何内容", () => {
    expect(takeHead("正文", 0)).toEqual([undefined, "正文"]);
    expect(takeTail("正文", 0)).toBe("");
  });

  it("硬切不把代理对切成两半", () => {
    const text = "\u{20000}".repeat(10);
    const pieces = sliceByTokenBudget(text, 3);
    expect(pieces.join("")).toBe(text);
    for (const piece of pieces) {
      expect(piece).not.toMatch(/[\uD800-\uDBFF]$/);
    }
  });

  it("空行切段落：去空白、丢空段", () => {
    expect(splitParagraphs("  一  \n\n\n 二 \n\n  ")).toEqual(["一", "二"]);
    expect(splitParagraphs("   ")).toEqual([]);
  });
});

describe("Markdown 分段：标题树", () => {
  it("每段带当前标题层级路径，标题行留在段内", () => {
    const segments = segmentMarkdown("# 指南\n\n引言\n\n## 安装\n\n### Windows\n\n双击运行");
    expect(segments.map((segment) => segment.headingPath)).toEqual([
      ["指南"],
      ["指南"],
      ["指南", "安装"],
      ["指南", "安装", "Windows"],
      ["指南", "安装", "Windows"],
    ]);
    expect(segments[0]?.text).toBe("# 指南");
    expect(segments[0]?.boundary).toBe("structure");
    expect(segments[1]?.boundary).toBe("paragraph");
  });

  it("同级标题会弹出上一节，不会越积越深", () => {
    const segments = segmentMarkdown("## 安装\n\n甲\n\n## 卸载\n\n乙");
    const paths = segments.map((segment) => segment.headingPath);
    expect(paths).toContainEqual(["安装"]);
    expect(paths).toContainEqual(["卸载"]);
    expect(paths).not.toContainEqual(["安装", "卸载"]);
  });

  it("围栏代码块整体成段，块内的 # 与 --- 不当标题", () => {
    const segments = segmentMarkdown("## 示例\n\n```bash\n# 这是注释\n---\npnpm dev\n```\n\n收尾");
    const fenced = segments.find((segment) => segment.text.startsWith("```"));
    expect(fenced?.text).toBe("```bash\n# 这是注释\n---\npnpm dev\n```");
    // 注释行没有制造出新的标题层级
    expect(segments.every((segment) => (segment.headingPath ?? []).length <= 1)).toBe(true);
  });

  it("setext 标题按 === / --- 识别，下划线不进正文", () => {
    const segments = segmentMarkdown("上一段\n\n标题\n====\n\n正文");
    expect(segments.map((segment) => segment.text)).toEqual(["上一段", "标题", "正文"]);
    expect(segments[1]?.headingPath).toEqual(["标题"]);
    expect(segments[2]?.headingPath).toEqual(["标题"]);
  });

  it("文首 YAML frontmatter 不进正文；未闭合的 --- 按普通内容处理", () => {
    expect(segmentMarkdown("---\ntitle: x\n---\n\n正文").map((s) => s.text)).toEqual(["正文"]);
    expect(segmentMarkdown("---\ntitle: x\n\n正文").map((s) => s.text)).toEqual([
      "---\ntitle: x",
      "正文",
    ]);
  });

  it("# 后不接空白的不是标题（话题标签）", () => {
    const segments = segmentMarkdown("#话题 不是标题");
    expect(segments[0]?.headingPath).toBeUndefined();
    expect(segments[0]?.boundary).toBe("paragraph");
  });
});

describe("源码分段：函数/类边界", () => {
  it("按顶层声明切开，声明前的注释归属其后的声明", () => {
    const segments = segmentCode(
      [
        "import { a } from './a.js';",
        "",
        "/** 融合两路排名。 */",
        "export function fuse(x: number): number {",
        "  return x;",
        "}",
        "",
        "export class Planner {",
        "  plan(): void {}",
        "}",
      ].join("\n"),
    );
    expect(segments).toHaveLength(3);
    expect(segments[0]?.text).toBe("import { a } from './a.js';");
    expect(segments[1]?.text.startsWith("/** 融合两路排名。 */")).toBe(true);
    expect(segments[2]?.text.startsWith("export class Planner {")).toBe(true);
    expect(segments.every((segment) => segment.boundary === "structure")).toBe(true);
  });

  it("无关键字的 C 家族函数定义靠 `(...) {` 兜底识别", () => {
    const segments = segmentCode(
      ["#include <stdio.h>", "", "int main(int argc) {", "  return 0;", "}"].join("\n"),
    );
    expect(segments).toHaveLength(2);
    expect(segments[1]?.text.startsWith("int main(int argc) {")).toBe(true);
  });

  it("缩进的成员不是边界，整个类保持完整", () => {
    const segments = segmentCode(
      ["class A {", "  def one(self):", "    pass", "  def two(self):", "    pass", "}"].join("\n"),
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toContain("def two(self):");
  });

  it("认不出声明的文件退回按空行分段，不整篇塞成一块", () => {
    const segments = segmentCode("键 = 值\n路径 = /tmp\n\n开关 = 开\n阈值 = 3");
    expect(segments).toHaveLength(2);
    expect(segments.every((segment) => segment.boundary === "paragraph")).toBe(true);
  });
});

describe("按格式选分段策略（segmentDocument）", () => {
  it("PDF 按页分段，每段带页码，页首段为结构边界", () => {
    const segments = segmentDocument(
      documentOf({
        format: "pdf",
        pages: [
          { page: 1, text: "第一页甲\n\n第一页乙" },
          { page: 2, text: "第二页" },
        ],
      }),
    );
    expect(segments.map((segment) => segment.page)).toEqual([1, 1, 2]);
    expect(segments.map((segment) => segment.boundary)).toEqual([
      "structure",
      "paragraph",
      "structure",
    ]);
  });

  it("PDF 空页不产段，其后页码不错位", () => {
    const segments = segmentDocument(
      documentOf({
        format: "pdf",
        pages: [
          { page: 1, text: "" },
          { page: 2, text: "有内容" },
        ],
      }),
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]?.page).toBe(2);
  });

  it("html / docx / text 走段落分段，不带标题路径与页码", () => {
    for (const format of ["html", "docx", "text"] as const) {
      const segments = segmentDocument(documentOf({ format, text: "甲\n\n乙" }));
      expect(segments).toHaveLength(2);
      expect(segments[0]?.headingPath).toBeUndefined();
      expect(segments[0]?.page).toBeUndefined();
    }
  });
});

describe("打包：块大小、结构收口与重叠", () => {
  const { minTokens, maxTokens } = DEFAULT_CHUNKING_PARAMS;

  /** 断言块大小满足 [下限, 上限]（末块可低于下限）。 */
  function expectSizes(chunks: readonly ChunkDraft[]): void {
    chunks.forEach((chunk, index) => {
      expect(estimateTokens(chunk.text)).toBe(chunk.tokens);
      expect(chunk.tokens).toBeLessThanOrEqual(maxTokens);
      if (index < chunks.length - 1) {
        expect(chunk.tokens).toBeGreaterThanOrEqual(minTokens);
      }
    });
    expect(chunks.map((chunk) => chunk.seq)).toEqual(chunks.map((_, index) => index));
  }

  it("长文档切成多块，块大小落在 300~800 token，seq 连续", () => {
    const text = Array.from({ length: 12 }, (_, index) => paragraph(8, index * 8)).join("\n\n");
    const chunks = chunkDocument(documentOf({ format: "text", text }), OPTIONS);
    expect(chunks.length).toBeGreaterThan(2);
    expectSizes(chunks);
  });

  it("单个超长段落（无空行）同样被切开且不超上限", () => {
    const chunks = chunkDocument(documentOf({ format: "text", text: paragraph(200) }), OPTIONS);
    expect(chunks.length).toBeGreaterThan(3);
    expectSizes(chunks);
  });

  it("因大小切开的相邻块之间带约 15% 重叠", () => {
    const chunks = chunkDocument(documentOf({ format: "text", text: paragraph(200) }), OPTIONS);
    const first = chunks[0];
    const second = chunks[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const overlap = takeTail(first?.text ?? "", Math.round(maxTokens * 0.15));
    expect(overlap).not.toBe("");
    expect(second?.text.startsWith(overlap)).toBe(true);
    // 重叠量按上限的 15% 计，允许一个原子的取整误差
    expect(estimateTokens(overlap)).toBeGreaterThan(Math.round(maxTokens * 0.15) / 2);
  });

  it("跨标题的块之间不重叠（结构边界本身即语义边界，出处须干净）", () => {
    // 每节约 400 token：够格独立成块，又装得进一个块，故切点只可能是标题
    const text = `# 甲\n\n${paragraph(12)}\n\n# 乙\n\n${paragraph(12, 100)}`;
    const chunks = chunkDocument(documentOf({ format: "markdown", text }), OPTIONS);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.provenance.headingPath).toEqual(["甲"]);
    expect(chunks[1]?.provenance.headingPath).toEqual(["乙"]);
    // 第二块不含第一节的任何句子
    expect(chunks[1]?.text).not.toContain("第11句");
    expect(chunks[1]?.text.startsWith("# 乙")).toBe(true);
  });

  it("小节太短时跨标题续合，出处取块首段所在小节", () => {
    const text = "# 甲\n\n很短的一节。\n\n# 乙\n\n也很短。";
    const chunks = chunkDocument(documentOf({ format: "markdown", text }), OPTIONS);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.provenance.headingPath).toEqual(["甲"]);
    expect(chunks[0]?.text).toContain("# 乙");
  });

  it("PDF 块带页码出处", () => {
    const chunks = chunkDocument(
      documentOf({
        format: "pdf",
        pages: [
          { page: 1, text: paragraph(12) },
          { page: 2, text: paragraph(12, 100) },
        ],
      }),
      { filePath: "D:\\docs\\报告.pdf" },
    );
    expect(chunks.map((chunk) => chunk.provenance.page)).toEqual([1, 2]);
    expect(chunks[0]?.provenance.filePath).toBe("D:\\docs\\报告.pdf");
    expect(chunks[0]?.provenance.headingPath).toBeUndefined();
  });

  it("空文档与纯空白文档不产块", () => {
    expect(chunkDocument(documentOf({ format: "text", text: "" }), OPTIONS)).toEqual([]);
    expect(chunkDocument(documentOf({ format: "text", text: " \n\n \t " }), OPTIONS)).toEqual([]);
  });

  it("极短文档产出一个低于下限的块，而不是丢弃内容", () => {
    const chunks = chunkDocument(documentOf({ format: "text", text: "只有一句话。" }), OPTIONS);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe("只有一句话。");
  });

  it("自定义参数生效：块上限被压小则块数变多", () => {
    const text = paragraph(120);
    const wide = chunkDocument(documentOf({ format: "text", text }), OPTIONS);
    const narrow = chunkDocument(documentOf({ format: "text", text }), {
      ...OPTIONS,
      minTokens: 60,
      maxTokens: 160,
    });
    expect(narrow.length).toBeGreaterThan(wide.length);
    for (const chunk of narrow) {
      expect(chunk.tokens).toBeLessThanOrEqual(160);
    }
  });

  it("重叠比例为 0 时块间无重复内容", () => {
    const chunks = chunkDocument(documentOf({ format: "text", text: paragraph(120) }), {
      ...OPTIONS,
      overlapRatio: 0,
    });
    expect(chunks.length).toBeGreaterThan(1);
    const tail = takeTail(chunks[0]?.text ?? "", 20);
    expect(chunks[1]?.text.startsWith(tail)).toBe(false);
  });

  it("不自洽的参数立即抛 RangeError，不静默纠偏", () => {
    const document = documentOf({ format: "text", text: "正文" });
    expect(() => chunkDocument(document, { ...OPTIONS, minTokens: 0 })).toThrow(RangeError);
    expect(() => chunkDocument(document, { ...OPTIONS, maxTokens: 100, minTokens: 100 })).toThrow(
      RangeError,
    );
    expect(() => chunkDocument(document, { ...OPTIONS, overlapRatio: 0.5 })).toThrow(RangeError);
    expect(() => chunkDocument(document, { ...OPTIONS, overlapRatio: -0.1 })).toThrow(RangeError);
    // 扣掉重叠后内容预算低于下限 → 两个约束互相矛盾
    expect(() =>
      chunkDocument(document, { ...OPTIONS, minTokens: 90, maxTokens: 100, overlapRatio: 0.15 }),
    ).toThrow(RangeError);
  });

  it("大文档：内容不丢、块不超限、耗时线性（容量目标万级文档/十万级块）", () => {
    const total = 3000;
    const text = Array.from({ length: total / 10 }, (_, group) => paragraph(10, group * 10)).join(
      "\n\n",
    );
    const started = performance.now();
    const chunks = chunkDocument(documentOf({ format: "text", text }), OPTIONS);
    const elapsed = performance.now() - started;

    expectSizes(chunks);
    // 每一句都能在某个块里找到——分块不许吞内容
    const joined = chunks.map((chunk) => chunk.text).join("\n");
    for (let index = 0; index < total; index += 1) {
      expect(joined).toContain(`第${index}句`);
    }
    // 约 10 万字的文档：线性实现下远快于此，留足十倍余量只为拦住退化成平方的改动
    expect(elapsed).toBeLessThan(5000);
  });

  it("空段序列不产块", () => {
    const empty: readonly Segment[] = [];
    expect(packSegments(empty, "a.md", DEFAULT_CHUNKING_PARAMS)).toEqual([]);
  });
});

describe("落成领域实体（toKnowledgeChunks）", () => {
  it("补上条目归属与块 ID，其余字段原样承接", () => {
    const drafts = chunkDocument(documentOf({ format: "text", text: paragraph(60) }), OPTIONS);
    const entryId = "entry-1" as KnowledgeEntryId;
    const chunks = toKnowledgeChunks(drafts, {
      entryId,
      newId: (draft) => `entry-1#${draft.seq}` as KnowledgeChunkId,
    });
    expect(chunks).toHaveLength(drafts.length);
    expect(chunks.map((chunk) => chunk.id)).toEqual(drafts.map((draft) => `entry-1#${draft.seq}`));
    expect(chunks.every((chunk) => chunk.entryId === entryId)).toBe(true);
    expect(chunks[0]?.text).toBe(drafts[0]?.text);
    expect(chunks[0]?.provenance).toEqual(drafts[0]?.provenance);
  });

  it("空草稿列表得到空块列表", () => {
    expect(
      toKnowledgeChunks([], {
        entryId: "e" as KnowledgeEntryId,
        newId: () => "c" as KnowledgeChunkId,
      }),
    ).toEqual([]);
  });
});

describe("各格式分块快照（解析 → 分块 端到端）", () => {
  /** 快照只留结构信息与正文首行，避免整段正文变动淹没真正的分块行为回归。 */
  function outline(chunks: readonly ChunkDraft[]): readonly unknown[] {
    return chunks.map((chunk) => ({
      seq: chunk.seq,
      tokens: chunk.tokens,
      provenance: chunk.provenance,
      firstLine: (chunk.text.split("\n")[0] ?? "").slice(0, 40),
    }));
  }

  for (const [name, params] of [
    ["sample.md", { minTokens: 40, maxTokens: 120 }],
    ["sample.ts", { minTokens: 40, maxTokens: 120 }],
    ["sample.txt", { minTokens: 40, maxTokens: 120 }],
    ["sample.html", { minTokens: 40, maxTokens: 120 }],
    ["sample.docx", { minTokens: 40, maxTokens: 120 }],
    ["sample.pdf", { minTokens: 40, maxTokens: 120 }],
  ] as const) {
    it(`${name} 的分块结构稳定`, async () => {
      const filePath = join(FIXTURES, name);
      const document = await parseFile(filePath);
      // fixture 都是小文件，故压小块尺寸才切得出多块；出处逻辑与默认参数一致
      const chunks = chunkDocument(document, { filePath: name, ...params });
      expect(outline(chunks)).toMatchSnapshot();
      for (const chunk of chunks) {
        expect(chunk.tokens).toBeLessThanOrEqual(params.maxTokens);
      }
    });
  }

  it("Markdown 块的出处标题路径跟随小节推进", async () => {
    const document = await parseFile(join(FIXTURES, "sample.md"));
    // 块尺寸压得更小，三级标题才够格独立成块——出处深度取决于块的起始段
    const chunks = chunkDocument(document, {
      filePath: "sample.md",
      minTokens: 10,
      maxTokens: 80,
    });
    const paths = chunks.map((chunk) => chunk.provenance.headingPath);
    expect(paths).toContainEqual(["知识库使用指南", "安装", "Windows"]);
    expect(paths.every((path) => path?.[0] === "知识库使用指南")).toBe(true);
  });
});
