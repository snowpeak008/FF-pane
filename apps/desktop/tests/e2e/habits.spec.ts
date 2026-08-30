/**
 * 冒烟 4：共享记忆（习惯）CRUD（T5.1，§8.2）。
 *
 * 习惯是全局作用域，经 window.ffpane.invoke 驱动真实 preload→主进程→storage 全链路
 * （校验 IPC 契约 + preload 允许清单 + 落盘往返），无需项目、无网络，hermetic。
 */

import { expect, test } from "@playwright/test";
import { type LaunchedApp, launchApp } from "./_launch";

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp();
});

test.afterAll(async () => {
  await launched.cleanup();
});

test("习惯 创建 → 列举 → 相近检测 → 停用 → 删除 全链路", async () => {
  const { page } = launched;

  const result = await page.evaluate(async () => {
    const invoke = (channel: string, req?: unknown) =>
      // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
      (window as any).ffpane.invoke(channel, req);

    const created = await invoke("habits:create", {
      draft: {
        category: "workflow",
        content: "任何改动前先跑一遍现有测试",
        status: "active",
        enabled: true,
        source: { kind: "user_manual" },
        importance: 80,
      },
    });

    const listed = await invoke("habits:list");
    const conflicts = await invoke("habits:check-conflicts", {
      category: "workflow",
      content: "改动前先跑一遍现有测试",
    });
    const disabled = await invoke("habits:set-enabled", { id: created.id, enabled: false });
    const rejected = await invoke("habits:reject", { id: created.id });
    const afterDelete = await invoke("habits:list");

    return {
      createdId: created.id,
      listedCount: listed.length,
      conflictCount: conflicts.length,
      disabledEnabled: disabled.enabled,
      removed: rejected.removed,
      afterDeleteCount: afterDelete.length,
    };
  });

  expect(result.createdId).toMatch(/^hab-/);
  expect(result.listedCount).toBe(1);
  expect(result.conflictCount).toBeGreaterThanOrEqual(1);
  expect(result.disabledEnabled).toBe(false);
  expect(result.removed).toBe(true);
  expect(result.afterDeleteCount).toBe(0);
});
