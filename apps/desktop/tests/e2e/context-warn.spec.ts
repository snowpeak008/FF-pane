/**
 * T9.8 ② 上下文阈值提醒 E2E（hermetic，不跑真 Agent）。
 *
 * 路径照 session-replay.spec 款式：预写 `.workbench/sessions.json` + 回放本，进会话页
 * 自动回放——回放出的历史消息就是字符估算路径的分子载体（本 spec 无 Profile、无真实
 * usage，正是「取不到 CLI usage 按转录累计字符估算并标注」那条合同路径）。断言：
 * 1. 横幅触发（估算分子 400K 字符 ≈ 100K token / 保守默认窗 128K ≈ 78% ≥ 默认阈值 70%）
 *    且带「(estimated)」标注；
 * 2. 横幅上的一键继承入口打开 inherit 意图的 HandoffDialog（接 T9.8 ①）；
 * 3. 设置页阈值设置项真落盘（config:update → config:get 读回）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

let launched: LaunchedApp;
let projectDir: string;

const SESSION_ID = "sess-e2e-ctx";

/** 预写一条带超长 assistant 文本的会话（估算分子 ≈ 100K token，超默认 70% 阈值）。 */
function seedBloatedSessionOnDisk(projectRoot: string): void {
  const workbench = join(projectRoot, ".workbench");
  const sessionDir = join(workbench, "sessions", SESSION_ID);
  mkdirSync(sessionDir, { recursive: true });

  writeFileSync(
    join(workbench, "sessions.json"),
    JSON.stringify({
      version: 1,
      sessions: [
        {
          id: SESSION_ID,
          profileId: "prof-e2e",
          role: "planner",
          createdAt: 1_700_000_000_000,
          lastActiveAt: 1_700_000_100_000,
        },
      ],
    }),
    "utf8",
  );

  // 400,000 ASCII 字符 ≈ 100,000 token（4:1 折算）；窗口走保守默认 128K → 约 78%
  const bloated = "x".repeat(400_000);
  const entries = [
    { kind: "user_message", turnId: "turn-1", at: 1_700_000_000_000, text: "big task" },
    { kind: "assistant_message", turnId: "turn-1", at: 1_700_000_000_500, text: bloated },
    {
      kind: "turn_end",
      turnId: "turn-1",
      at: 1_700_000_000_600,
      role: "planner",
      profileId: "prof-e2e",
      endReason: "completed",
    },
  ];
  writeFileSync(
    join(sessionDir, "transcript.jsonl"),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
}

test.beforeAll(async () => {
  launched = await launchApp();
  projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-ctx-"));
  seedBloatedSessionOnDisk(projectDir);

  await launched.page.evaluate(async (rootPath: string) => {
    // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
    const entry = await (window as any).ffpane.invoke("projects:create", {
      name: "E2E CtxWarn",
      rootPath,
    });
    window.localStorage.setItem(
      "ffpane.ui-state",
      JSON.stringify({ state: { activeProjectId: entry.id }, version: 1 }),
    );
  }, projectDir);
  await launched.page.reload();
  await launched.page.waitForLoadState("domcontentloaded");
  await gotoRoute(launched.page, "/session");
});

test.afterAll(async () => {
  await launched.cleanup();
  rmSync(projectDir, { recursive: true, force: true });
});

test("估算分子超阈值 → 横幅触发且标注 (estimated)，一键继承打开 inherit 对话框", async () => {
  const { page } = launched;

  // 回放先到位（估算的载体），随后横幅按估算分子触发
  await expect(page.getByText("big task")).toBeVisible();
  const banner = page.getByTestId("context-usage-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/Context is about \d+% full/);
  await expect(banner).toContainText("(estimated)");

  // 横幅上的一键继承入口（接 ①）：打开 inherit 意图的交接包对话框。
  // 状态条上还有一个同名常驻入口，用横幅容器收窄到横幅内那个
  await banner.getByRole("button", { name: "Continue in fresh session" }).click();
  await expect(page.getByRole("heading", { name: "Continue in fresh session" })).toBeVisible();
  const preview = page.locator("#handoff-text");
  await expect(preview).toHaveValue(/跨 Agent 交接包/);
  await page.keyboard.press("Escape");
});

test("设置页阈值设置项：默认 70%，改 50% 真落盘", async () => {
  const { page } = launched;

  await gotoRoute(page, "/settings");
  const select = page.locator("#setting-context-warn-percent");
  await expect(select).toBeVisible();
  await expect(select).toHaveValue("70");

  await select.selectOption("50");
  await expect(select).toHaveValue("50");
  // 真落盘：config:get 读回 50（不是只有 UI 状态变了）
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
        const config = await (window as any).ffpane.invoke("config:get");
        return config.contextWarnPercent;
      }),
    )
    .toBe(50);
});
