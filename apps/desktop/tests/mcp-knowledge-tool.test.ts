/**
 * 只读检索工具的声明 / 入参解析 / 结果渲染单测（T6.6）：纯逻辑。
 * 覆盖：工具面只读、query 必填、limit 夹取、过滤项择净、出处渲染、
 * 检索模式如实告知、零命中不是错误、审计片段截断（含代理对不切半）。
 */

import type { KnowledgeEntry, KnowledgeQueryHit } from "@ff-pane/shared";
import type { KnowledgeSearchHit } from "@ff-pane/storage";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOOL_LIMIT,
  formatProvenance,
  KNOWLEDGE_SEARCH_TOOL,
  MAX_TOOL_LIMIT,
  parseToolArgs,
  renderToolResult,
  SNIPPET_MAX_CHARS,
  toQueryHits,
} from "../src/mcp/knowledge-tool";

function makeHit(overrides: {
  readonly text?: string;
  readonly headingPath?: readonly string[];
  readonly page?: number;
}): KnowledgeSearchHit {
  return {
    chunk: {
      id: "chunk-1" as KnowledgeSearchHit["chunk"]["id"],
      entryId: "entry-1" as KnowledgeSearchHit["chunk"]["entryId"],
      seq: 0,
      text: overrides.text ?? "块正文",
      provenance: {
        filePath: "docs/guide.md",
        ...(overrides.headingPath !== undefined ? { headingPath: overrides.headingPath } : {}),
        ...(overrides.page !== undefined ? { page: overrides.page } : {}),
      },
    },
    score: 0.5,
    sources: ["fts"],
    ranks: { fts: 1 },
    before: [],
    after: [],
  };
}

const ENTRY = { title: "使用指南" } as KnowledgeEntry;

describe("工具声明", () => {
  it("只读：名字与描述都不承诺任何写能力", () => {
    expect(KNOWLEDGE_SEARCH_TOOL.name).toBe("knowledge_search");
    expect(KNOWLEDGE_SEARCH_TOOL.description).toContain("Read-only");
  });

  it("query 必填、limit 有上限、不接受未声明参数", () => {
    const schema = KNOWLEDGE_SEARCH_TOOL.inputSchema as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { maximum?: number }>;
    };
    expect(schema.required).toEqual(["query"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties["limit"]?.maximum).toBe(MAX_TOOL_LIMIT);
  });

  it("不暴露导入时间过滤（Agent 对它没有判断依据）", () => {
    const schema = KNOWLEDGE_SEARCH_TOOL.inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual([
      "query",
      "limit",
      "formats",
      "tags",
      "sourcePathPrefix",
    ]);
  });
});

describe("parseToolArgs", () => {
  it("query 缺失 / 空白是硬错误——静默返回空结果会让模型误判知识库里没有内容", () => {
    expect(parseToolArgs({})).toMatchObject({ ok: false });
    expect(parseToolArgs({ query: "   " })).toMatchObject({ ok: false });
    expect(parseToolArgs({ query: 42 })).toMatchObject({ ok: false });
  });

  it("query 去首尾空白，limit 缺省", () => {
    const parsed = parseToolArgs({ query: "  RRF 融合 " });
    expect(parsed).toMatchObject({
      ok: true,
      args: { query: "RRF 融合", limit: DEFAULT_TOOL_LIMIT },
    });
  });

  it("limit 越界夹到合法区间而不是报错（模型给 100 是想多要点）", () => {
    expect(parseToolArgs({ query: "a", limit: 100 })).toMatchObject({
      ok: true,
      args: { limit: MAX_TOOL_LIMIT },
    });
    expect(parseToolArgs({ query: "a", limit: 0 })).toMatchObject({ ok: true, args: { limit: 1 } });
    expect(parseToolArgs({ query: "a", limit: 3.7 })).toMatchObject({
      ok: true,
      args: { limit: 3 },
    });
  });

  it("limit 非数字回落缺省，不报错", () => {
    expect(parseToolArgs({ query: "a", limit: "many" })).toMatchObject({
      ok: true,
      args: { limit: DEFAULT_TOOL_LIMIT },
    });
  });

  it("formats 只留合法格式；全非法则整项缺席（而不是变成空数组把结果过滤空）", () => {
    const good = parseToolArgs({ query: "a", formats: ["markdown", "不存在的格式", "pdf"] });
    expect(good).toMatchObject({ ok: true, args: { formats: ["markdown", "pdf"] } });

    const bad = parseToolArgs({ query: "a", formats: ["不存在的格式"] });
    expect((bad as { args: { formats?: unknown } }).args.formats).toBeUndefined();
  });

  it("tags / sourcePathPrefix 择净空值", () => {
    const parsed = parseToolArgs({
      query: "a",
      tags: ["api", "", 5],
      sourcePathPrefix: "  docs/  ",
    });
    expect(parsed).toMatchObject({ ok: true, args: { tags: ["api"], sourcePathPrefix: "docs/" } });

    const blank = parseToolArgs({ query: "a", sourcePathPrefix: "   " });
    expect(
      (blank as { args: { sourcePathPrefix?: unknown } }).args.sourcePathPrefix,
    ).toBeUndefined();
  });
});

describe("toQueryHits", () => {
  it("带出条目标题与出处；正文截断成审计片段", () => {
    const [hit] = toQueryHits(
      [makeHit({ headingPath: ["安装", "Windows"], page: 3 })],
      () => ENTRY,
    );
    expect(hit).toMatchObject({
      title: "使用指南",
      filePath: "docs/guide.md",
      headingPath: ["安装", "Windows"],
      page: 3,
      snippet: "块正文",
    });
  });

  it("条目查不到时退回文件路径，不让审计整体失败", () => {
    const [hit] = toQueryHits([makeHit({})], () => undefined);
    expect(hit?.title).toBe("docs/guide.md");
  });

  it("超长正文截断到上限并加省略号", () => {
    const long = "字".repeat(SNIPPET_MAX_CHARS + 50);
    const [hit] = toQueryHits([makeHit({ text: long })], () => ENTRY);
    expect([...(hit?.snippet ?? "")]).toHaveLength(SNIPPET_MAX_CHARS + 1);
    expect(hit?.snippet.endsWith("…")).toBe(true);
  });

  it("截断不切开代理对（emoji 不会变成半个码位）", () => {
    const emoji = "🙂".repeat(SNIPPET_MAX_CHARS + 10);
    const [hit] = toQueryHits([makeHit({ text: emoji })], () => ENTRY);
    expect(hit?.snippet).not.toContain("�");
    expect([...(hit?.snippet ?? "")].slice(0, 3).join("")).toBe("🙂🙂🙂");
  });

  it("缺省的 headingPath / page 不落成 undefined 字段", () => {
    const [hit] = toQueryHits([makeHit({})], () => ENTRY);
    expect("headingPath" in (hit as object)).toBe(false);
    expect("page" in (hit as object)).toBe(false);
  });
});

describe("formatProvenance", () => {
  /** 出处渲染只看 filePath/headingPath/page 三项，其余字段给最小合法值即可。 */
  function provenanceOf(fields: Partial<KnowledgeQueryHit>): KnowledgeQueryHit {
    return {
      entryId: "e" as KnowledgeQueryHit["entryId"],
      chunkId: "c" as KnowledgeQueryHit["chunkId"],
      title: "t",
      filePath: "a.md",
      score: 0,
      snippet: "",
      ...fields,
    };
  }

  it("文件路径 + 标题路径 + 页码逐级带出", () => {
    expect(
      formatProvenance(
        provenanceOf({ filePath: "docs/guide.md", headingPath: ["安装", "Windows"], page: 3 }),
      ),
    ).toBe("docs/guide.md — 安装 › Windows — p.3");
  });

  it("只有路径时不留多余分隔符", () => {
    expect(formatProvenance(provenanceOf({ filePath: "a.md" }))).toBe("a.md");
  });
});

describe("renderToolResult", () => {
  const hits = toQueryHits([makeHit({ headingPath: ["安装"] })], () => ENTRY);

  it("如实告知只走了关键词路——否则模型会把'没搜到'误判成'库里没有'", () => {
    const text = renderToolResult({
      query: "a",
      hits,
      fullTexts: ["全文"],
      usedFts: true,
      usedVector: false,
    });
    expect(text).toContain("keyword only");
    expect(text).toContain("semantic search is not enabled");
  });

  it("查询过短回退子串扫描时说明原因", () => {
    const text = renderToolResult({
      query: "ab",
      hits,
      fullTexts: ["全文"],
      usedFts: false,
      usedVector: false,
    });
    expect(text).toContain("substring fallback");
  });

  it("给模型的是块全文，不是审计里的截断片段", () => {
    const long = "字".repeat(SNIPPET_MAX_CHARS + 50);
    const text = renderToolResult({
      query: "a",
      hits: toQueryHits([makeHit({ text: long })], () => ENTRY),
      fullTexts: [long],
      usedFts: true,
      usedVector: false,
    });
    expect(text).toContain(long);
    expect(text).not.toContain("…");
  });

  it("每条命中都带出处行，供模型引用", () => {
    const text = renderToolResult({
      query: "a",
      hits,
      fullTexts: ["全文"],
      usedFts: true,
      usedVector: false,
    });
    expect(text).toContain("## [1] 使用指南");
    expect(text).toContain("Source: docs/guide.md — 安装");
  });

  it("零命中是有效答案而不是错误", () => {
    const text = renderToolResult({
      query: "找不到的东西",
      hits: [],
      fullTexts: [],
      usedFts: true,
      usedVector: false,
    });
    expect(text).toContain("No matches");
    expect(text).toContain("找不到的东西");
  });
});
