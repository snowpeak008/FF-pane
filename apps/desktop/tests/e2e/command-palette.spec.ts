/**
 * 命令面板与全局键位（T8.1）。
 *
 * 为什么必须是 E2E：本单交付的核心是「面板挂上了、键位只被处理一次」，这两件事
 * 单测都覆盖不到——纯逻辑层的注册表在 W3.1c 就已全绿，而它绿着的那段时间里，
 * 面板根本没挂进 App.tsx。键位跳几次更是只有真实 DOM 上按一下才知道。
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
  projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-palette-"));
});

test.afterAll(async () => {
  await launched.cleanup();
  rmSync(projectDir, { recursive: true, force: true });
});

/** 当前路由（去掉 HashRouter 的 "#" 前缀）。 */
async function currentRoute(): Promise<string> {
  return launched.page.evaluate(() => window.location.hash.replace(/^#/, ""));
}

test("Ctrl+K 打开命令面板，Esc 收起", async () => {
  const { page } = launched;
  await gotoRoute(page, "/projects");

  const palette = page.getByPlaceholder(/Search commands/i);
  await expect(palette).toBeHidden();

  await page.keyboard.press("Control+K");
  await expect(palette).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
});

test("面板里选中一条导航命令即跳转（命令项经注入的 navigate 走真实路由）", async () => {
  const { page } = launched;
  await gotoRoute(page, "/projects");

  await page.keyboard.press("Control+K");
  await page.getByPlaceholder(/Search commands/i).fill("memory");
  await page
    .getByRole("option", { name: /Go to memory/i })
    .first()
    .click();

  await expect.poll(currentRoute).toBe("/memory");
});

test("Ctrl+1~7 逐个落在对应页面，Alt+← 退回上一页", async () => {
  const { page } = launched;
  // 页面切换键位现在由注册表独家处理（AppLayout 那条自建监听已删）。
  //
  // 一处实测更正（开工前的预判不准，此处以实测为准）：两条监听并存时**并不会**跳两次。
  // 注册表的监听挂在 window 捕获阶段且命中即 stopPropagation，而 AppLayout 那条挂在
  // 冒泡阶段——捕获阶段停传后，冒泡侧根本收不到这个事件。实测（临时探针）为：
  // 冒泡侧监听只收到过单独的 Control 键（未命中键位、不停传），Ctrl+3 一次都没收到。
  // 也就是说那条监听早已是**事实上的死代码**，只是死得很隐蔽——它的失效依赖于
  // 「另一处恰好在捕获阶段停传」这个远处的实现细节，一旦那边改用冒泡就会立刻变成跳两次。
  // 这正是它必须删而不是留着的理由，也是为什么本条断言不宣称自己能测出「跳两次」：
  // 「不存在第二个实现」由 command-ipc.test.ts 的源码断言守，本条守的是键位确实好使。
  const expected = [
    ["Control+1", "/projects"],
    ["Control+2", "/session"],
    ["Control+3", "/plan"],
    ["Control+4", "/tasks"],
    ["Control+5", "/runs"],
    ["Control+6", "/memory"],
    ["Control+7", "/knowledge"],
  ] as const;

  for (const [key, route] of expected) {
    await page.keyboard.press(key);
    await expect.poll(currentRoute).toBe(route);
  }

  // 后退一次回到上一个页面：这同时证明每次切页只往历史里压一条
  // （若某天有人再引入第二个处理者且它走冒泡侧仍能收到事件，这里会停在 /knowledge）。
  await page.keyboard.press("Alt+ArrowLeft");
  await expect.poll(currentRoute).toBe("/memory");
});

test("「从知识库插入」在会话页不再是「待接入」，执行后对话框真的打开", async () => {
  const { page } = launched;

  // 该命令的 handler 由会话输入区（Composer）在挂载时自报，而输入区只在选中项目后
  // 才渲染（未选项目时会话页是 NoActiveProject 空态）。故先建一个项目并设为当前项目。
  await page.evaluate(async (rootPath: string) => {
    // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
    const entry = await (window as any).ffpane.invoke("projects:create", {
      name: "E2E Palette",
      rootPath,
    });
    // 当前项目存在 ui store 的 persist 分片里（stores/ui.ts 的 UI_STORE_STORAGE_KEY）
    window.localStorage.setItem(
      "ffpane.ui-state",
      JSON.stringify({ state: { activeProjectId: entry.id }, version: 1 }),
    );
  }, projectDir);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await gotoRoute(page, "/session");

  // 输入区已挂载（它就是自报 handler 的那个组件）
  await expect(page.getByRole("button", { name: /Insert from knowledge base/i })).toBeVisible();

  await page.keyboard.press("Control+K");
  await page.getByPlaceholder(/Search commands/i).fill("knowledge");
  const item = page.getByRole("option", { name: /insert from knowledge base/i }).first();
  await expect(item).toBeVisible();
  // 未接入的命令会被渲染成 disabled 并带一行「待接入」说明（CommandPalette 的 hint）
  await expect(item).not.toHaveAttribute("data-disabled", "true");

  // 执行它：命令真的通到了页面的动作上，而不只是"看起来可点"
  await item.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
});
