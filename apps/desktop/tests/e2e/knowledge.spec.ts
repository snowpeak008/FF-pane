/**
 * 冒烟 5：知识库导入 → 检索 → 导出前置 → 移除（T6.5，§8.3）。
 *
 * 走 window.ffpane.invoke 驱动真实 preload → 主进程 → rag 管道 → SQLite 全链路，
 * 验证的是**装配**而不是编排细节（后者由 knowledge-ingest.test.ts 覆盖）：
 * handler 是否注册上、索引库是否开得起来、sqlite-vec 加载失败是否照常降级、
 * FTS5 检索是否在打包产物里真的能跑。
 *
 * 无嵌入模型 → 纯全文检索路径（§8.3.3），故 hermetic：不联网、不需要 Provider。
 * 导入源文件写在 E2E 的临时数据根下，随 cleanup 一并删除。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { type LaunchedApp, launchApp } from "./_launch";

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp();
});

test.afterAll(async () => {
  await launched.cleanup();
});

test("知识库 导入 → 混合检索 → 增量跳过 → 移除 全链路", async () => {
  const { page, dataRoot } = launched;

  // 造两份真实文档：一份讲索引、一份讲权限，检索时应当只命中前者
  const docsDir = join(dataRoot, "e2e-docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(
    join(docsDir, "retrieval.md"),
    `# 检索设计\n\n${"知识库采用 FTS5 与向量双路召回，再用 RRF 融合排序。".repeat(20)}\n`,
    "utf8",
  );
  writeFileSync(
    join(docsDir, "permission.md"),
    `# 权限设计\n\n${"运行时权限层在事前拦截并把危险操作上浮给用户确认。".repeat(20)}\n`,
    "utf8",
  );

  const result = await page.evaluate(async (dir: string) => {
    const invoke = (channel: string, req?: unknown) =>
      // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
      (window as any).ffpane.invoke(channel, req);

    const first = await invoke("knowledge:import", {
      importId: "e2e-1",
      paths: [dir],
      tags: ["e2e"],
    });
    const overview = await invoke("knowledge:list");
    const hitSearch = await invoke("knowledge:search", { query: "RRF 融合" });
    const missSearch = await invoke("knowledge:search", { query: "这段文字任何文档里都没有" });
    const filtered = await invoke("knowledge:search", {
      query: "融合",
      filters: { formats: ["pdf"] },
    });
    // 第二次导入同一目录：内容未变，应当整批走增量跳过
    const second = await invoke("knowledge:import", { importId: "e2e-2", paths: [dir] });

    const firstEntryId = overview.entries[0]?.entry.id;
    const removed = await invoke("knowledge:remove-entry", { id: firstEntryId });
    const afterRemove = await invoke("knowledge:list");

    return {
      first,
      second,
      entryCount: overview.entries.length,
      totalChunks: overview.totalChunks,
      embeddingAvailable: overview.embedding.available,
      embeddingBlocker: overview.embedding.blocker,
      hasVectorIndex: overview.vector !== undefined,
      hitTitles: hitSearch.hits.map((hit: { entryTitle: string }) => hit.entryTitle),
      hitUsedFts: hitSearch.usedFts,
      hitUsedVector: hitSearch.usedVector,
      missCount: missSearch.hits.length,
      filteredCount: filtered.hits.length,
      removedOk: removed.removed,
      afterRemoveCount: afterRemove.entries.length,
    };
  }, docsDir);

  // 导入：两个文件各成一条，块数为正，无失败
  expect(result.first.scanned).toBe(2);
  expect(result.first.indexed).toBe(2);
  expect(result.first.failures).toEqual([]);
  expect(result.first.chunks).toBeGreaterThan(0);
  expect(result.entryCount).toBe(2);
  expect(result.totalChunks).toBe(result.first.chunks);

  // 没有配嵌入 Provider → 纯全文检索降级（§8.3.3：功能完整可用，不是错误）
  expect(result.embeddingAvailable).toBe(false);
  expect(result.embeddingBlocker).toBe("no-provider");
  expect(result.hasVectorIndex).toBe(false);
  expect(result.first.embedded).toBe(0);

  // 检索：命中讲检索的那篇，不命中讲权限的那篇
  expect(result.hitUsedFts).toBe(true);
  expect(result.hitUsedVector).toBe(false);
  expect(result.hitTitles.length).toBeGreaterThan(0);
  expect(new Set(result.hitTitles)).toEqual(new Set(["retrieval"]));
  expect(result.missCount).toBe(0);
  // 过滤先于召回：库里没有 PDF，故按 PDF 过滤必然为空
  expect(result.filteredCount).toBe(0);

  // 增量索引：内容没变，第二轮全部跳过、不再写块
  expect(result.second.indexed).toBe(0);
  expect(result.second.skipped).toBe(2);
  expect(result.second.chunks).toBe(0);

  // 移除来源：条目连同其索引一并消失
  expect(result.removedOk).toBe(true);
  expect(result.afterRemoveCount).toBe(1);
});

test("知识库 手动新建 / 会话收录：落 notes 文件 → 建索引 → 检索得到 → 重建仍在", async () => {
  const { page, dataRoot } = launched;

  const result = await page.evaluate(async () => {
    const invoke = (channel: string, req?: unknown) =>
      // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
      (window as any).ffpane.invoke(channel, req);

    const manual = await invoke("knowledge:create-entry", {
      importId: "e2e-note-1",
      title: "灰度发布约定",
      content: "先切 5% 流量观察十分钟，指标正常再全量。回滚必须先停写。",
      tags: ["发布", "约定"],
      source: { kind: "manual" },
    });
    const captured = await invoke("knowledge:create-entry", {
      importId: "e2e-note-2",
      title: "会话结论",
      content: "传输选 stdio 而不是 HTTP，因为它不监听端口、与 VPN 无关。",
      source: { kind: "session_capture", sessionId: "ls-e2e" },
    });
    // 空正文必须被当场拒绝，而不是落一条永远检索不到的空条目
    let emptyRejected = false;
    try {
      await invoke("knowledge:create-entry", {
        importId: "e2e-note-3",
        title: "空的",
        content: "   ",
        source: { kind: "manual" },
      });
    } catch {
      emptyRejected = true;
    }

    const found = await invoke("knowledge:search", { query: "灰度发布" });
    const overview = await invoke("knowledge:list");
    // 重建：笔记走的是 notes/ 下那份原文件，不该在重建里消失或变成 file_import
    const rebuilt = await invoke("knowledge:rebuild", { importId: "e2e-note-4" });
    const afterRebuild = await invoke("knowledge:list");

    const noteEntries = afterRebuild.entries.filter(
      (view: { entry: { origin: { kind: string } } }) => view.entry.origin.kind !== "file_import",
    );
    return {
      manual,
      captured,
      emptyRejected,
      foundTitles: found.hits.map((hit: { entryTitle: string }) => hit.entryTitle),
      origins: overview.entries.map(
        (view: { entry: { origin: { kind: string } } }) => view.entry.origin.kind,
      ),
      capturedOrigin: overview.entries.find(
        (view: { entry: { id: string } }) => view.entry.id === captured.entryId,
      )?.entry.origin,
      rebuiltIndexed: rebuilt.indexed,
      rebuiltFailures: rebuilt.failures,
      noteCount: noteEntries.length,
      noteChunkCounts: noteEntries.map((view: { chunkCount: number }) => view.chunkCount),
    };
  });

  // 落库：各产出块，无失败
  expect(result.manual.report.indexed).toBe(1);
  expect(result.manual.report.chunks).toBeGreaterThan(0);
  expect(result.manual.report.failures).toEqual([]);
  expect(result.captured.report.indexed).toBe(1);

  // 文件是真实数据源（§8.4）：正文确实落在 knowledge/notes/ 下，用户可直接编辑
  expect(result.manual.path.replaceAll("\\", "/")).toContain("/knowledge/notes/");
  expect(readFileSync(result.manual.path, "utf8")).toContain("# 灰度发布约定");

  // 空正文当场拒绝
  expect(result.emptyRejected).toBe(true);

  // 检索得到手写的那条
  expect(result.foundTitles).toContain("灰度发布约定");

  // 来源如实记录：一条 manual、一条 session_capture（带会话 ID）
  expect(result.origins).toContain("manual");
  expect(result.origins).toContain("session_capture");
  expect(result.capturedOrigin).toEqual({ kind: "session_capture", sessionId: "ls-e2e" });

  // 重建后笔记还在、块还在，来源没有被改写成 file_import
  expect(result.rebuiltFailures).toEqual([]);
  expect(result.rebuiltIndexed).toBeGreaterThanOrEqual(2);
  expect(result.noteCount).toBe(2);
  for (const count of result.noteChunkCounts) {
    expect(count).toBeGreaterThan(0);
  }

  expect(dataRoot).toBeTruthy();
});
