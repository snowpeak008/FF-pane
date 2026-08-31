/**
 * T6.5 知识库页纯视图逻辑单测：出处轨迹、引用文本、过滤项派生、条目筛选、索引状态、进度。
 *
 * 引用文本是这里最要紧的一项——它会被原样发进 Agent 的上下文（§8.3.5），
 * 格式错了是用户直接看得见、且会污染对话的事故。
 */

import type { KnowledgeChunk, KnowledgeChunkId, KnowledgeEntryId } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  buildKnowledgeCitation,
  buildKnowledgeCitations,
  deriveFilterOptions,
  directoryOf,
  entryIndexState,
  fileNameOf,
  formatProvenanceTrail,
  matchesEntrySearch,
  PROVENANCE_SEPARATOR,
  progressPercent,
  sourcePathOf,
} from "../src/renderer/src/pages/knowledge/knowledge-view";
import type { KnowledgeEntryView, KnowledgeHitView } from "../src/shared-ipc/contracts";

function chunk(overrides: Partial<KnowledgeChunk> = {}): KnowledgeChunk {
  return {
    id: "kc-1" as KnowledgeChunkId,
    entryId: "ke-1" as KnowledgeEntryId,
    seq: 0,
    text: "安装步骤如下。",
    provenance: { filePath: "D:/docs/guide.md" },
    ...overrides,
  };
}

function hit(overrides: Partial<KnowledgeHitView> = {}): KnowledgeHitView {
  return {
    chunk: chunk(),
    score: 0.5,
    sources: ["fts"],
    before: [],
    after: [],
    entryTitle: "安装指南",
    entryFormat: "markdown",
    ...overrides,
  };
}

function entryView(overrides: {
  readonly id?: string;
  readonly title?: string;
  readonly sourcePath?: string;
  readonly tags?: readonly string[];
  readonly format?: KnowledgeEntryView["entry"]["format"];
  readonly chunkCount?: number;
  readonly embeddedCount?: number;
}): KnowledgeEntryView {
  return {
    entry: {
      id: (overrides.id ?? "ke-1") as KnowledgeEntryId,
      title: overrides.title ?? "安装指南",
      format: overrides.format ?? "markdown",
      origin: { kind: "file_import", sourcePath: overrides.sourcePath ?? "D:/docs/guide.md" },
      contentHash: "sha256:x",
      importedAt: 1_700_000_000_000,
      ...(overrides.tags === undefined ? {} : { tags: overrides.tags }),
    },
    chunkCount: overrides.chunkCount ?? 10,
    embeddedCount: overrides.embeddedCount ?? 0,
  };
}

describe("路径拆解", () => {
  it("取文件名与目录，正反斜杠都吃", () => {
    expect(fileNameOf("D:/docs/guide.md")).toBe("guide.md");
    expect(fileNameOf("D:\\docs\\guide.md")).toBe("guide.md");
    expect(fileNameOf("guide.md")).toBe("guide.md");
    expect(directoryOf("D:\\docs\\sub\\guide.md")).toBe("D:/docs/sub");
    expect(directoryOf("guide.md")).toBe("guide.md");
  });
});

describe("出处轨迹", () => {
  it("文件名 + 标题路径；无页码时不显示页码那一级", () => {
    const trail = formatProvenanceTrail(
      hit({
        chunk: chunk({
          provenance: { filePath: "D:/docs/g.md", headingPath: ["安装", "Windows"] },
        }),
      }),
    );
    expect(trail).toEqual(["g.md", "安装", "Windows"]);
  });

  it("有页码且给了页码文案时才追加页码", () => {
    const withPage = hit({
      chunk: chunk({ provenance: { filePath: "D:/docs/g.pdf", page: 3 } }),
    });
    expect(formatProvenanceTrail(withPage, "第 3 页")).toEqual(["g.pdf", "第 3 页"]);
    // 页码文案由调用方从语言包取；没给就不猜
    expect(formatProvenanceTrail(withPage)).toEqual(["g.pdf"]);
  });
});

describe("引用文本", () => {
  it("正文按 Markdown 引用块缩进，出处单独一行", () => {
    const citation = buildKnowledgeCitation(hit({ chunk: chunk({ text: "第一行\n\n第二行" }) }), {
      sourceLabel: "来源：",
    });
    const lines = citation.split("\n");

    expect(lines[0]).toBe("> 第一行");
    // 空行也要带 ">"，否则 Markdown 会把引用块在此断开
    expect(lines[1]).toBe(">");
    expect(lines[2]).toBe("> 第二行");
    expect(citation).toContain("来源：安装指南");
    expect(citation).toContain("D:/docs/guide.md");
  });

  it("出处含标题路径与页码，末尾恒为完整文件路径", () => {
    const citation = buildKnowledgeCitation(
      hit({
        chunk: chunk({
          provenance: { filePath: "D:/docs/g.pdf", headingPath: ["安装"], page: 3 },
        }),
      }),
      { sourceLabel: "来源：", pageLabel: "第 3 页" },
    );
    const trail = citation.split("来源：")[1] ?? "";
    expect(trail.split(PROVENANCE_SEPARATOR)).toEqual([
      "安装指南",
      "安装",
      "第 3 页",
      "D:/docs/g.pdf",
    ]);
  });

  it("不把上下文扩展块塞进引用（那是给人看的阅读辅助，不占 Agent 上下文预算）", () => {
    const citation = buildKnowledgeCitation(
      hit({
        before: [chunk({ id: "kc-0" as KnowledgeChunkId, text: "前一块" })],
        after: [chunk({ id: "kc-2" as KnowledgeChunkId, text: "后一块" })],
      }),
      { sourceLabel: "来源：" },
    );
    expect(citation).not.toContain("前一块");
    expect(citation).not.toContain("后一块");
  });

  it("多条命中之间以空行分隔", () => {
    const text = buildKnowledgeCitations(
      [hit({ chunk: chunk({ text: "甲" }) }), hit({ chunk: chunk({ text: "乙" }) })],
      { sourceLabel: "来源：" },
    );
    expect(text).toContain("> 甲");
    expect(text).toContain("> 乙");
    expect(text.split("\n\n").length).toBeGreaterThan(2);
  });
});

describe("过滤项派生", () => {
  it("格式 / 标签 / 来源目录全部去重并升序", () => {
    const options = deriveFilterOptions([
      entryView({ id: "a", sourcePath: "D:/docs/x.md", tags: ["检索", "架构"] }),
      entryView({ id: "b", sourcePath: "D:/docs/y.md", tags: ["架构"], format: "pdf" }),
      entryView({ id: "c", sourcePath: "D:/notes/z.md" }),
    ]);

    expect(options.formats).toEqual(["markdown", "pdf"]);
    expect(options.tags).toEqual(["架构", "检索"]);
    expect(options.directories).toEqual(["D:/docs", "D:/notes"]);
  });

  it("空库派生出空选项，不产生 undefined", () => {
    expect(deriveFilterOptions([])).toEqual({ formats: [], tags: [], directories: [] });
  });
});

describe("条目筛选", () => {
  it("按标题 / 路径 / 标签匹配，大小写不敏感；空查询全通过", () => {
    const view = entryView({ title: "Install Guide", sourcePath: "D:/docs/g.md", tags: ["架构"] });

    expect(matchesEntrySearch(view, "")).toBe(true);
    expect(matchesEntrySearch(view, "install")).toBe(true);
    expect(matchesEntrySearch(view, "docs")).toBe(true);
    expect(matchesEntrySearch(view, "架构")).toBe(true);
    expect(matchesEntrySearch(view, "不存在")).toBe(false);
  });

  it("非 file_import 条目没有来源路径", () => {
    expect(sourcePathOf(entryView({}).entry)).toBe("D:/docs/guide.md");
    expect(
      sourcePathOf({
        ...entryView({}).entry,
        origin: { kind: "manual" },
      }),
    ).toBeUndefined();
  });
});

describe("索引状态", () => {
  it("没有向量索引时是「全文索引」而不是「未完成」（纯 FTS 是正常状态，不是缺陷）", () => {
    expect(entryIndexState(entryView({ chunkCount: 10, embeddedCount: 0 }), false)).toBe(
      "keyword-only",
    );
  });

  it("有向量索引时按覆盖率分已完成 / 部分", () => {
    expect(entryIndexState(entryView({ chunkCount: 10, embeddedCount: 10 }), true)).toBe("indexed");
    expect(entryIndexState(entryView({ chunkCount: 10, embeddedCount: 3 }), true)).toBe("partial");
  });

  it("零块条目单列一态（解析出空文档，不该显示成「已建索引」）", () => {
    expect(entryIndexState(entryView({ chunkCount: 0, embeddedCount: 0 }), true)).toBe("empty");
    expect(entryIndexState(entryView({ chunkCount: 0, embeddedCount: 0 }), false)).toBe("empty");
  });
});

describe("进度百分比", () => {
  it("总数未知时返回 undefined（交给不确定态进度条，不假装进度）", () => {
    expect(progressPercent(3, 0)).toBeUndefined();
    expect(progressPercent(0, 10)).toBe(0);
    expect(progressPercent(5, 10)).toBe(50);
    expect(progressPercent(10, 10)).toBe(100);
    // 越界钳制：进度事件与最终报告之间可能短暂不一致
    expect(progressPercent(12, 10)).toBe(100);
  });
});
