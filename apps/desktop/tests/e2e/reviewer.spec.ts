/**
 * 冒烟 9：Reviewer 角色（T7.2，§3.1）。
 *
 * 走 window.ffpane.invoke 驱动真实 preload → 主进程 → storage 全链路，验证的是**装配**
 * 而非审查逻辑本身（后者由 packages/core 的 review 单测与编排器单测覆盖）：
 * 项目级开关与绑定是否真落进 project.json 并读得回来、默认是否关闭、受理前的两道
 * 归属校验（任务 / Run 存在且配对）是否在真实读盘链路上成立。
 *
 * 界面那一半验证「默认关闭 = 卡片上没有审查按钮」这条 §3.1 的产品承诺。
 *
 * hermetic：不联网、不真的跑一轮审查（那需要真机 CLI）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

let launched: LaunchedApp;
let projectDir: string;

test.beforeAll(async () => {
  launched = await launchApp();
  projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-reviewer-"));
});

test.afterAll(async () => {
  await launched.cleanup();
  rmSync(projectDir, { recursive: true, force: true });
});

test("Reviewer 项目级开关：默认关闭 → 开启并绑定 → 关掉不丢绑定", async () => {
  const { app, page } = launched;

  await app.evaluate(async ({ dialog }, dir) => {
    // biome-ignore lint/suspicious/noExplicitAny: E2E 打桩覆盖原生 API，仅测试期生效
    (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, projectDir);

  const result = await page.evaluate(async (dir: string) => {
    const invoke = (channel: string, req?: unknown) =>
      // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
      (window as any).ffpane.invoke(channel, req);

    await invoke("projects:create", { name: "E2E Reviewer", rootPath: dir });
    const initial = await invoke("projects:get-settings", { projectRoot: dir });
    const bound = await invoke("projects:update-settings", {
      projectRoot: dir,
      patch: { reviewerEnabled: true, reviewerProfileId: "prof-reviewer" },
    });
    const off = await invoke("projects:update-settings", {
      projectRoot: dir,
      patch: { reviewerEnabled: false },
    });
    const reread = await invoke("projects:get-settings", { projectRoot: dir });
    return { initial, bound, off, reread };
  }, projectDir);

  // §3.1「可选，默认关闭」
  expect(result.initial.reviewerEnabled).toBe(false);
  expect(result.initial.reviewerProfileId).toBeUndefined();

  expect(result.bound).toMatchObject({
    reviewerEnabled: true,
    reviewerProfileId: "prof-reviewer",
  });
  // 关掉开关不清绑定：反复开开关关时不必每次重选审查者
  expect(result.off).toMatchObject({ reviewerEnabled: false, reviewerProfileId: "prof-reviewer" });
  expect(result.reread).toMatchObject({
    reviewerEnabled: false,
    reviewerProfileId: "prof-reviewer",
  });

  // 知识库工具开关不受牵连（同一份 project.json，两个独立字段）
  expect(result.reread.knowledgeToolEnabled).toBe(false);
});

test("审查轮受理前的归属校验：任务 / Run 不存在或不配对一律拒绝受理", async () => {
  const { page } = launched;

  const acks = await page.evaluate(async (dir: string) => {
    const invoke = (channel: string, req?: unknown) =>
      // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
      (window as any).ffpane.invoke(channel, req);

    return {
      noTask: await invoke("session:start", {
        turnId: "e2e-review-1",
        projectRoot: dir,
        profileId: "prof-nonexistent",
        input: { kind: "reviewer-review", taskId: "task-nope", runId: "run-nope" },
      }),
    };
  }, projectDir);

  // 这个项目里没有 Profile、没有任务、没有 Run —— 三道关卡任何一道拦下都算对，
  // 要紧的是**不受理**：一次没有材料的审查不该真的起一个进程去问模型。
  expect(acks.noTask.accepted).toBe(false);
  expect(typeof acks.noTask.reason).toBe("string");
});

test("默认关闭时任务页不显示审查入口（§3.1：关着的角色不该出现在界面上）", async () => {
  const { page } = launched;

  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await gotoRoute(page, "/projects");
  await page.getByRole("button", { name: /^E2E Reviewer/ }).click();
  await gotoRoute(page, "/tasks");

  // 开关条常驻（含空态）：用户开工前正是在这里顺手把它打开
  const toggle = page.getByRole("checkbox", { name: "Enable reviewer" });
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();

  // 关着的时候连绑定下拉框都不该出现
  await expect(page.getByRole("combobox", { name: "Reviewer profile" })).toHaveCount(0);
});
