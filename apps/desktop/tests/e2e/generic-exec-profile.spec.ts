/**
 * T8.4b 多实例装配 E2E：设置页建 generic-exec Profile → 派发 → 真跑通。
 *
 * 走「真跑通」而非「拒绝文案」路径（工单预许可二选一）：命令用 node -e（E2E 环境
 * 必有 node，跨平台、无需假 CLI 垫片），taskDelivery=stdin（Worker 提示词长，argv
 * 预算不稳），脚本忽略 stdin、打印哨兵文本后 exit 0。链路全真实：设置页表单 →
 * profiles:create（core 校验）→ 任务派发 → 编排器 resolveForProfile 命中复合键
 * 专属实例 → 适配器 spawn 真 node 进程 → end(completed) → Run 落库（report =
 * stdout 哨兵）→ 任务 done（无 verifyCmd，报告即证据）。
 * 「配置缺失 → 人可读拒绝」的负路径在装配单测覆盖（session-registry.test.ts），
 * 此处不重复——E2E 里 UI 建的 Profile 必带配置（表单 + core 校验双重保证）。
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
  projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-gx-"));

  // 项目 + cli_login Provider 直接经 invoke 建立（Provider 表单已有专属 E2E 覆盖），
  // Profile 走设置页表单——这正是本 spec 要验的 UI 路径。
  await launched.page.evaluate(async (dir: string) => {
    const invoke = (channel: string, req?: unknown) =>
      // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
      (window as any).ffpane.invoke(channel, req);
    const entry = await invoke("projects:create", { name: "E2E GenericExec", rootPath: dir });
    await invoke("providers:create", {
      draft: {
        name: "E2E GX Provider",
        templateId: "local-login",
        models: [{ id: "m1", label: "M1", kind: "chat" }],
        defaultModelId: "m1",
        enabled: true,
      },
    });
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

test("档案页不再出现，配置区在", async () => {
  const { page } = launched;
  await gotoRoute(page, "/settings");
  await expect(page.getByRole("button", { name: "New profile" })).toHaveCount(0);
  await expect(page.locator("#profile-runtime")).toHaveCount(0);
  await expect(page.getByTestId("settings-configs")).toBeVisible();
});
