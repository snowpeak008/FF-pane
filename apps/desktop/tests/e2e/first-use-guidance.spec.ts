/**
 * T9.6 首用引导修复 E2E（行为级，一条链三个用例按首用顺序展开）：
 *
 * 1. **② 缺 Planner Profile 的引导空态**：项目已选中但无任何 Profile 时，会话页
 *    消息流空态显示显式引导 +「去设置」按钮，点击即达设置页——修复缺席时该状态下
 *    唯一提示藏在 Composer 禁用 tooltip 里（不可发现）。
 * 2. **⑤ 首个 Profile 默认角色 = planner**：设置页零 Profile 时打开新建对话框，
 *    默认角色下拉为 planner；经 IPC 建成一个 Profile 后重开，恢复 worker 缺省。
 * 3. **③ 选中项目 toast 带「去会话页」动作**：项目页点卡片 → toast 出现动作按钮，
 *    点击即达会话页；此时 planner Profile 已就位（用例 2 建的），会话页空态回到
 *    常规文案、不再出现「去设置」——② 的条件渲染反向钉子。
 *
 * hermetic：Provider 用 cli_login 类型（无 baseUrl / 无密钥），不联网、不起 Agent。
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
  projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-guide-"));

  // 建项目并设为当前项目（照 config-tool.spec 款式：写 ui-state 后 reload 生效）
  await launched.page.evaluate(async (dir: string) => {
    const invoke = (channel: string, req?: unknown) =>
      // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
      (window as any).ffpane.invoke(channel, req);
    const entry = await invoke("projects:create", { name: "E2E Guidance", rootPath: dir });
    window.localStorage.setItem(
      "ffpane.ui-state",
      JSON.stringify({ state: { activeProjectId: entry.id }, version: 1 }),
    );
  }, projectDir);
  await launched.page.reload();
  await launched.page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await launched.cleanup();
  rmSync(projectDir, { recursive: true, force: true });
});

test("② 项目已选中但无 Profile：会话页空态给「去设置」引导，点击即达设置页", async () => {
  const { page } = launched;
  await gotoRoute(page, "/session");

  // 引导文案 + 主操作按钮（不再只靠 Composer 禁用 tooltip）
  await expect(
    page.getByText("No profile can host a discussion yet", { exact: false }),
  ).toBeVisible();
  const goToSettings = page.getByRole("button", { name: "Go to Settings" });
  await expect(goToSettings).toBeVisible();

  await goToSettings.click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
});

test("⑤ 零 Profile 时新建对话框默认角色 = planner；已有 Profile 后恢复 worker", async () => {
  const { page } = launched;
  await gotoRoute(page, "/settings");

  // 零 Profile：空态主操作打开编辑器 → 默认角色 planner
  await page.getByRole("button", { name: "New profile" }).click();
  await expect(page.locator("#profile-role")).toHaveValue("planner");
  await page.getByRole("button", { name: "Cancel" }).click();

  // 经 IPC 建 Provider + planner Profile（cli_login hermetic；⑤ 的「已有」前提）
  await page.evaluate(async () => {
    const invoke = (channel: string, req?: unknown) =>
      // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
      (window as any).ffpane.invoke(channel, req);
    const provider = await invoke("providers:create", {
      draft: {
        name: "E2E Guide CLI",
        type: "cli_login",
        models: [{ id: "m1", displayName: "M1", kind: "chat" }],
        defaultModel: "m1",
        enabled: true,
      },
    });
    await invoke("profiles:create", {
      draft: {
        name: "E2E Guide Planner",
        runtime: "codex",
        providerId: provider.id,
        defaultRole: "planner",
        permissionPreset: {
          readPaths: ["**"],
          writePaths: [],
          shell: "forbidden",
          network: false,
          dangerousOpsRequireApproval: true,
        },
      },
    });
  });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await gotoRoute(page, "/settings");

  // 已有 Profile：列表区头部按钮打开编辑器 → 默认角色回到 worker 缺省
  await expect(page.getByText("E2E Guide Planner")).toBeVisible();
  await page.getByRole("button", { name: "New profile" }).click();
  await expect(page.locator("#profile-role")).toHaveValue("worker");
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("③ 选中项目 toast 带「去会话页」动作；planner 就位后 ② 引导消失（反向钉子）", async () => {
  const { page } = launched;
  await gotoRoute(page, "/projects");

  // 点卡片选中项目 → toast 出现「去会话页」动作按钮
  await page.getByRole("button", { name: /^E2E Guidance/ }).click();
  const goToSession = page.getByRole("button", { name: "Go to session" });
  await expect(goToSession).toBeVisible();
  await goToSession.click();
  await expect(page.getByRole("heading", { name: "Session" })).toBeVisible();

  // planner Profile 已就位：空态回到常规文案（① 新文案指向输入框，不再指向项目页），
  // 「去设置」按钮不出现——② 的条件渲染反向面
  await expect(page.getByText("No messages in this session yet", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Go to Settings" })).toHaveCount(0);
});
