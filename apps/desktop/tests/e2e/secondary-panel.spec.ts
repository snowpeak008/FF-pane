/**
 * T9.7 B 栏布局壳 + 项目快速切换器 E2E。
 *
 * 覆盖合同验收面：
 * 1. 项目列表为空时 B 栏整栏隐藏；有项目时常显；
 * 2. A/B 独立收展（按钮 + Ctrl+B / Ctrl+Shift+B 全局键位）；
 * 3. 点击项目条目 = 切换活跃项目 + 会话窗口切到该项目；
 * 4. 落定高亮真实链路：派发 Worker 轮（假 codex 立即退出码 1，无任何事件——
 *    适配器兜底判 crashed）→ 编排器 settleTaskAfterRun 把任务落 failed →
 *    saveTask 落盘点推 tasks:settled → B 栏未读圆点；
 * 5. 已读消除：点击该项目条目（切项目 + 到会话页）即消除；
 * 6. 已读持久化：未读 reload 后仍在（未读不丢）、已读 reload 后不复活。
 *
 * hermetic：不联网；假 codex 经 PATH 前置（task-parallel.spec 同款注入方式，但
 * 用**立即退出**替身而非挂起替身：本 spec 要的是「轮快速落定」，挂起替身得走
 * 取消 + 树杀链路，那是 task-parallel 已登记的负载性慢路径，不该被本 spec 复用）。
 *
 * B 栏条目的可访问名是「Switch to project: <名>」（动作语义，见 ProjectSwitcher），
 * 与项目页卡片（可访问名以裸项目名开头）天然可分，选择器不撞。
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

let launched: LaunchedApp;
let alphaDir: string;
let betaDir: string;
let fakeBinDir: string;

const TURN_ID = "e2e-bpanel-turn";
const ALPHA_ITEM = "Switch to project: E2E BP Alpha";
const BETA_ITEM = "Switch to project: E2E BP Beta";

/** 立即失败退出的假 codex：无输出、退出码 1 → 适配器兜底 end(crashed) → 任务 failed。 */
function seedFakeCodex(dir: string): void {
  writeFileSync(join(dir, "codex.cmd"), "@echo off\r\nexit /b 1\r\n", "utf8");
  const posix = join(dir, "codex");
  writeFileSync(posix, "#!/bin/sh\nexit 1\n", "utf8");
  chmodSync(posix, 0o755);
}

/** 一个 pending 任务（供派发）。 */
function seedTask(projectRoot: string): void {
  const tasksDir = join(projectRoot, ".workbench", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(tasksDir, "task-task-bp-1.json"),
    JSON.stringify(
      {
        id: "task-bp-1",
        planVersion: 1,
        goal: "secondary panel seed task",
        writeScope: ["src/**"],
        forbidden: [],
        dependsOn: [],
        contextRefs: [],
        acceptance: ["done"],
        status: "pending",
      },
      null,
      2,
    ),
    "utf8",
  );
}

test.beforeAll(async () => {
  fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-bp-bin-"));
  seedFakeCodex(fakeBinDir);
  launched = await launchApp({ pathPrepend: fakeBinDir });
  alphaDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-bp-alpha-"));
  betaDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-bp-beta-"));
});

test.afterAll(async () => {
  await launched.cleanup();
  for (const dir of [alphaDir, betaDir, fakeBinDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const panel = () => launched.page.locator('aside[aria-label="Secondary panel"]');

test("项目列表为空时 B 栏整栏隐藏；登记项目后常显且列出全部项目", async () => {
  const { page } = launched;

  // 空态：无项目 → 整栏不渲染
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(panel()).toHaveCount(0);

  // 登记两个项目 + cli_login Provider + Worker Profile（后续落定链路用）
  await page.evaluate(
    async (dirs: readonly string[]) => {
      const invoke = (channel: string, req?: unknown) =>
        // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
        (window as any).ffpane.invoke(channel, req);
      const alpha = await invoke("projects:create", { name: "E2E BP Alpha", rootPath: dirs[0] });
      await invoke("projects:create", { name: "E2E BP Beta", rootPath: dirs[1] });
      const provider = await invoke("providers:create", {
        draft: {
          name: "E2E BP CLI",
          templateId: "local-login",
          models: [{ id: "m1", label: "M1", kind: "chat" }],
          defaultModelId: "m1",
          enabled: true,
        },
      });
      await invoke("profiles:create", {
        draft: {
          name: "E2E BP Worker",
          runtime: "codex",
          providerId: provider.id,
          defaultRole: "worker",
          permissionPreset: {
            readPaths: ["**"],
            writePaths: ["**"],
            shell: "allowed",
            network: false,
            dangerousOpsRequireApproval: true,
          },
        },
      });
      // 活跃项目 = Alpha（Beta 的落定事件必须在非活跃项目上也可见）
      window.localStorage.setItem(
        "ffpane.ui-state",
        JSON.stringify({ state: { activeProjectId: alpha.id }, version: 2 }),
      );
    },
    [alphaDir, betaDir],
  );
  seedTask(betaDir);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  // 有项目即常显：两个条目都在
  await expect(panel()).toBeVisible();
  await expect(panel().getByRole("button", { name: ALPHA_ITEM })).toBeVisible();
  await expect(panel().getByRole("button", { name: BETA_ITEM })).toBeVisible();
});

test("A/B 独立收展：B 收起 A 不动；Ctrl+B 收 A、Ctrl+Shift+B 展 B，各自独立", async () => {
  const { page } = launched;

  // 收起 B：项目条目消失，但 A 栏（主导航）不受影响
  await panel().getByRole("button", { name: "Collapse secondary panel" }).click();
  await expect(panel().getByRole("button", { name: ALPHA_ITEM })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();

  // Ctrl+B 收起 A 栏：A 的收起按钮变展开；B 保持收起态（独立）
  await page.keyboard.press("Control+b");
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await expect(panel().getByRole("button", { name: "Expand secondary panel" })).toBeVisible();

  // Ctrl+Shift+B 展开 B：项目条目回来；A 仍收起（独立）
  await page.keyboard.press("Control+Shift+b");
  await expect(panel().getByRole("button", { name: ALPHA_ITEM })).toBeVisible();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();

  // 还原 A 展开，供后续用例
  await page.keyboard.press("Control+b");
  await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
});

test("点击项目条目：一步切换活跃项目 + 会话窗口切到该项目", async () => {
  const { page } = launched;
  await gotoRoute(page, "/projects");

  await panel().getByRole("button", { name: BETA_ITEM }).click();

  // 会话窗口已切换：路由到 /session
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 15_000 })
    .toBe("#/session");
  // 活跃项目已切换：B 栏 Beta 条目带选中态（aria-current），且会话页状态条显示 Beta
  await expect(panel().getByRole("button", { name: BETA_ITEM })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.getByText("E2E BP Beta", { exact: true })).toHaveCount(2);
});

test("落定高亮真实链路：Worker 轮崩退 → 任务 failed → 未读圆点；reload 不丢；已读后消除且 reload 不复活", async () => {
  const { page } = launched;

  // 落定要发生在**非活跃**项目上（活跃项目开着会话页 = 即时已读）：先切回 Alpha
  await panel().getByRole("button", { name: ALPHA_ITEM }).click();
  await expect(panel().getByRole("button", { name: ALPHA_ITEM })).toHaveAttribute(
    "aria-current",
    "true",
  );

  // 在 Beta 派发 Worker 轮：假 codex 立即退出码 1（无事件）→ 兜底 end(crashed)
  // → settleTaskAfterRun 落 failed → saveTask 落盘点推 tasks:settled
  const ack = await page.evaluate(
    async (args: { dir: string; turnId: string }) => {
      const invoke = (channel: string, req?: unknown) =>
        // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
        (window as any).ffpane.invoke(channel, req);
      const profiles = await invoke("profiles:list");
      return invoke("session:start", {
        turnId: args.turnId,
        projectRoot: args.dir,
        profileId: profiles[0].id,
        input: { kind: "worker-task", taskId: "task-bp-1" },
      });
    },
    { dir: betaDir, turnId: TURN_ID },
  );
  expect(ack.accepted).toBe(true);

  // 任务落 failed → tasks:settled → Beta 条目出现未读圆点（轮自行收尾，几秒内）
  const betaItem = panel().getByRole("button", { name: BETA_ITEM });
  await expect(betaItem.getByRole("status", { name: "A task failed (unread)" })).toBeVisible({
    timeout: 20_000,
  });

  // 未读持久化：reload 后未读圆点仍在（不丢）
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await expect(
    panel()
      .getByRole("button", { name: BETA_ITEM })
      .getByRole("status", { name: "A task failed (unread)" }),
  ).toBeVisible();

  // 已读：点击 Beta 条目（切换活跃项目 + 打开会话页）→ 高亮消除
  await panel().getByRole("button", { name: BETA_ITEM }).click();
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 15_000 })
    .toBe("#/session");
  await expect(panel().getByRole("button", { name: BETA_ITEM }).getByRole("status")).toHaveCount(0);

  // 已读持久化（合同硬验收：重启不复活已读项）：reload 后高亮不复活
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await expect(panel().getByRole("button", { name: BETA_ITEM })).toBeVisible();
  await expect(panel().getByRole("button", { name: BETA_ITEM }).getByRole("status")).toHaveCount(0);
});
