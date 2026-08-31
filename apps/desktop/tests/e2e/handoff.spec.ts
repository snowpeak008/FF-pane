/**
 * 冒烟 8：跨 Agent 交接包生成（T7.1，§10.4）。
 *
 * 走 window.ffpane.invoke 驱动真实 preload → 主进程 → storage（计划 / 任务 / 记忆三处读盘）
 * → core 组装渲染全链路。验证的是**装配**而非组装细节（后者由 packages/core 的 25 项单测覆盖）：
 * handler 是否注册上、读盘是否都接对了、未初始化项目（无 tasks 目录）是否按空集容错、
 * 记忆状态筛选是否在真实读盘链路上成立、以及 §10.4 红线——交接包里不该出现 Run 的原始日志面。
 *
 * hermetic：不联网、不需要 Provider 与 Profile（只生成交接包，不发起迁移轮）。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

/**
 * 直接在盘上造一条记忆条目（一条一文件 Markdown，§10.2 / W1.2c 的持久层约定）。
 * 记忆的写入 IPC 只有审核类通道（approve/reject/update），没有"凭空建一条"——
 * 那本是 Agent 提候选、用户审核的产物。E2E 要的是"库里确实有这条"，故按持久格式落盘，
 * 由主进程真实读回，链路与生产一致。
 */
function seedMemoryEntry(
  projectRoot: string,
  params: { readonly dir: string; readonly id: string; readonly category: string },
  status: string,
): void {
  const iso = new Date(1_700_000_000_000).toISOString();
  writeFileSync(
    join(projectRoot, ".workbench", "memory", params.dir, `${params.id}.md`),
    [
      "---",
      `id: ${params.id}`,
      `category: ${params.category}`,
      `status: ${status}`,
      "source: user_manual",
      "confidence: high",
      `created: ${iso}`,
      `updated: ${iso}`,
      "---",
      "",
      `# 条目 ${params.id}`,
      "",
      `这是 ${params.id} 的正文。`,
      "",
    ].join("\n"),
    "utf8",
  );
}

let launched: LaunchedApp;
let projectDir: string;

test.beforeAll(async () => {
  launched = await launchApp();
  projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-handoff-"));
});

test.afterAll(async () => {
  await launched.cleanup();
  rmSync(projectDir, { recursive: true, force: true });
});

test("交接包 空项目容错 → active 记忆入包 / candidate 不入 → 红线（无原始日志）", async () => {
  const { app, page } = launched;

  await app.evaluate(async ({ dialog }, dir) => {
    // biome-ignore lint/suspicious/noExplicitAny: E2E 打桩覆盖原生 API，仅测试期生效
    (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, projectDir);

  const result = await page.evaluate(async (dir: string) => {
    const invoke = (channel: string, req?: unknown) =>
      // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
      (window as any).ffpane.invoke(channel, req);

    await invoke("projects:create", { name: "E2E Handoff", rootPath: dir });

    // 刚建好的项目：没有计划、没有任务、没有记忆——交接包仍应生成得出来
    return { empty: await invoke("handoff:generate", { projectRoot: dir }) };
  }, projectDir);

  // 空项目：八节齐全，缺的维度如实写「（无）/尚无计划」而不是整节消失
  expect(result.empty.text).toContain("跨 Agent 交接包");
  expect(result.empty.text).toContain("（尚无计划。）");
  expect(result.empty.text).toContain("（尚未拆出任务）");
  expect(result.empty.taskCount).toBe(0);
  expect(result.empty.planVersion).toBeUndefined();

  // §10.4 红线：交接包不含原始执行日志面（取材源里根本没有 Run）
  expect(result.empty.text).not.toContain("raw.log");
  expect(result.empty.text).not.toContain("执行记录");

  // 落两条记忆：一条 active 的 rule 该进包，一条 candidate 的 decision 不该
  // （§8.1 —— 候选尚未经用户确认，交接出去等于把未确认的东西当成约束交给下一个 Agent）
  seedMemoryEntry(projectDir, { dir: "rules", id: "rule-active", category: "rule" }, "active");
  seedMemoryEntry(
    projectDir,
    { dir: "candidates", id: "dec-candidate", category: "decision" },
    "candidate",
  );

  const seeded = await launched.page.evaluate(async (dir: string) => {
    // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
    return (window as any).ffpane.invoke("handoff:generate", { projectRoot: dir });
  }, projectDir);

  expect(seeded.ruleCount).toBe(1);
  expect(seeded.decisionCount).toBe(0);
  expect(seeded.text).toContain("条目 rule-active");
  expect(seeded.text).not.toContain("dec-candidate");
});

test("会话页「换 Agent」入口打开预览对话框，正文预填且可编辑", async () => {
  const { page } = launched;

  // 上一条用例经 IPC 直接建的项目不在页面的查询缓存里，重载一次让列表拉到它
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  // 选中该项目为当前项目（项目卡片可点 = 设为当前项目）
  await gotoRoute(page, "/projects");
  await page.getByRole("button", { name: /^E2E Handoff/ }).click();
  await gotoRoute(page, "/session");

  await page.getByRole("button", { name: "Switch agent" }).click();

  // 预览框拿到主进程渲染的交接包正文（对话框打开即生成，不缓存上一次的快照）
  const preview = page.locator("#handoff-text");
  await expect(preview).toHaveValue(/跨 Agent 交接包/);
  // 可编辑——§10.4「预览可编辑」，且改完的这一份才是确认后要注入的那一份
  await preview.fill("我改过的交接包");
  await expect(preview).toHaveValue("我改过的交接包");

  // 本机没有任何 Profile，故没有迁移目标，确认按钮应保持禁用而不是让用户点了才报错
  await expect(page.getByRole("button", { name: "Confirm and hand off" })).toBeDisabled();
});
