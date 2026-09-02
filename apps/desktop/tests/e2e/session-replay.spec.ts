/**
 * T8.2b-b 会话回放与自动续接 E2E。
 *
 * 路径选择：既有 E2E 从不真的跑 Agent 轮次（hermetic，不联网、无 CLI），故按
 * 「预写持久化文件 + 应用真实读回」的既有款式（handoff.spec.ts 的 seedMemoryEntry 同款）：
 * 启动前向临时项目目录预写 `.workbench/sessions.json`（会话登记，storage/sessions/store.ts
 * 的整文件格式）与 `.workbench/sessions/<id>/transcript.jsonl`（回放本，一行一条
 * TranscriptEntry）——这正是"上次关掉应用时留下的磁盘现场"。断言进入会话页后自动
 * 回放消息、续接横幅、坏行提示、中断标注、以及「新建会话」的清空行为。
 * 链路全真实：renderer effect → sessions:latest / sessions:transcript IPC → 主进程
 * 启动修正 + storage 读盘 → 映射回放。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

let launched: LaunchedApp;
let projectDir: string;

const SESSION_ID = "sess-e2e-replay";

/** 预写会话登记 + 回放本（两轮：一轮完整、一轮被中断；外加一行坏数据）。 */
function seedSessionOnDisk(projectRoot: string): void {
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
          // 无 native 绑定 → 预判为上下文重建（Context rebuild）
        },
      ],
    }),
    "utf8",
  );

  const entries = [
    {
      kind: "user_message",
      turnId: "turn-1",
      at: 1_700_000_000_000,
      text: "please summarize the project",
    },
    {
      kind: "assistant_message",
      turnId: "turn-1",
      at: 1_700_000_000_500,
      text: "Here is the project summary from last time.",
    },
    {
      kind: "turn_end",
      turnId: "turn-1",
      at: 1_700_000_000_600,
      role: "planner",
      profileId: "prof-e2e",
      endReason: "completed",
    },
    {
      kind: "user_message",
      turnId: "turn-2",
      at: 1_700_000_050_000,
      text: "now refactor the parser",
    },
    {
      kind: "assistant_message",
      turnId: "turn-2",
      at: 1_700_000_050_500,
      text: "I started refactoring but",
      partial: true,
    },
    {
      kind: "turn_end",
      turnId: "turn-2",
      at: 1_700_000_050_600,
      role: "planner",
      profileId: "prof-e2e",
      endReason: "interrupted",
    },
  ];
  const lines = entries.map((entry) => JSON.stringify(entry));
  // 一行坏数据：读侧跳过并计数（skippedLines = 1），界面页脚如实标注
  lines.splice(3, 0, "{ this is not valid json");
  writeFileSync(join(sessionDir, "transcript.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

test.beforeAll(async () => {
  launched = await launchApp();
  projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-replay-"));
  seedSessionOnDisk(projectDir);

  // 登记项目并设为当前项目（与 command-palette.spec.ts 同款），再进会话页
  await launched.page.evaluate(async (rootPath: string) => {
    // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
    const entry = await (window as any).ffpane.invoke("projects:create", {
      name: "E2E Replay",
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

test("进入会话页自动回放上次对话：消息齐全 + 续接横幅（上下文重建）+ 坏行提示", async () => {
  const { page } = launched;

  // 两轮的用户/assistant 消息都回放出来（自动续接：无需任何点击）
  await expect(page.getByText("please summarize the project")).toBeVisible();
  await expect(page.getByText("Here is the project summary from last time.")).toBeVisible();
  await expect(page.getByText("now refactor the parser")).toBeVisible();
  await expect(page.getByText("I started refactoring but")).toBeVisible();

  // 续接横幅：无 native 绑定的会话预判为上下文重建，且给出「新建会话」按钮
  await expect(page.getByText("Resumed last session · Context rebuild")).toBeVisible();
  await expect(page.getByRole("button", { name: "New session" })).toBeVisible();

  // 恢复列表把该会话标为当前会话（自动选中确实落到了 activeSessionId）
  await expect(page.getByText("Current session")).toBeVisible();

  // 坏行提示：预写的 1 行非法 JSON 被跳过并如实标注（不打扰的页脚小字）
  await expect(page.getByText(/1 unreadable line/)).toBeVisible();
});

test("被中断轮次在消息流中显式标注", async () => {
  const { page } = launched;

  // turn-2 的 assistant_message{partial} + turn_end{interrupted} → 一条中断标注（不双份）
  const marker = page.getByText("This turn was interrupted because the app quit");
  await expect(marker).toHaveCount(1);
  await expect(marker).toBeVisible();
});

test("点「新建会话」：消息区清空、横幅消失、且不被自动续接拉回", async () => {
  const { page } = launched;

  await page.getByRole("button", { name: "New session" }).click();

  // 横幅与回放消息全部消失，回到全新会话空态
  await expect(page.getByText("Resumed last session · Context rebuild")).toBeHidden();
  await expect(page.getByText("please summarize the project")).toBeHidden();
  await expect(page.getByText(/No conversation in progress/)).toBeVisible();

  // 离开再回来：autoResumeDoneRoot 已记，本项目不再被自动拉回旧会话
  await gotoRoute(page, "/projects");
  await gotoRoute(page, "/session");
  await expect(page.getByText(/No conversation in progress/)).toBeVisible();
  await expect(page.getByText("Resumed last session · Context rebuild")).toBeHidden();
});
