/**
 * T8.3b 任务并行 E2E：任务页在飞轮次区呈现 + 派发冲突拒绝呈现 + 「等待后重试」自然路径。
 *
 * 路径选择：既有 E2E 从不联真机 Agent（hermetic），但「在飞」需要一个真的不结束的
 * 轮次——故向 PATH 前置一个**假 codex CLI**（挂起不退出的脚本），launch helper 的
 * `pathPrepend` 注入。链路全真实：任务派发 → session:start → 编排器互斥裁决 →
 * codex 适配器 spawn 假 CLI → 在飞登记 → sessions:active-turns → 任务页在飞区；
 * 相交任务的派发被真实裁决拒绝 → ack.conflicts → 冲突提示条。
 * 「真并发跑两轮」的端到端断言（两轮交错事件、Run 证据不串）在编排器单测覆盖
 * （session-orchestrator.test.ts T8.3b 节）——E2E 起两个真子进程再交错其输出无从
 * 脚本化，此处只验呈现（工单预许可的取舍，落档进度文档）。
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

let launched: LaunchedApp;
let projectDir: string;
let fakeBinDir: string;

const TURN_A = "e2e-par-turn-a";

/** 挂起不退出的假 codex：Windows 走 .cmd 垫片（ping 本机计时），POSIX 走 sh 脚本。 */
function seedFakeCodex(dir: string): void {
  writeFileSync(join(dir, "codex.cmd"), "@echo off\r\nping -n 86400 127.0.0.1 >nul\r\n", "utf8");
  const posix = join(dir, "codex");
  writeFileSync(posix, "#!/bin/sh\nsleep 86400\n", "utf8");
  chmodSync(posix, 0o755);
}

/** 两个 writeScope 相交的任务（src/app ⊃ src/app/sub），派发第二个必被拒。 */
function seedTasks(projectRoot: string): void {
  const tasksDir = join(projectRoot, ".workbench", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const base = {
    planVersion: 1,
    forbidden: [],
    dependsOn: [],
    contextRefs: [],
    acceptance: ["done"],
    status: "pending",
  };
  writeFileSync(
    join(tasksDir, "task-task-par-a.json"),
    JSON.stringify(
      { ...base, id: "task-par-a", goal: "parallel seed task A", writeScope: ["src/app"] },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    join(tasksDir, "task-task-par-b.json"),
    JSON.stringify(
      { ...base, id: "task-par-b", goal: "parallel seed task B", writeScope: ["src/app/sub"] },
      null,
      2,
    ),
    "utf8",
  );
}

test.beforeAll(async () => {
  fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-fakebin-"));
  seedFakeCodex(fakeBinDir);
  launched = await launchApp({ pathPrepend: fakeBinDir });
  projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-parallel-"));

  // 登记项目 + cli_login Provider + Worker Profile（runtime=codex → 假 CLI），
  // 再预写两个相交任务；设当前项目后重载进任务页。
  await launched.page.evaluate(async (dir: string) => {
    const invoke = (channel: string, req?: unknown) =>
      // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
      (window as any).ffpane.invoke(channel, req);
    const entry = await invoke("projects:create", { name: "E2E Parallel", rootPath: dir });
    const provider = await invoke("providers:create", {
      draft: {
        name: "E2E CLI",
        type: "cli_login",
        models: [{ id: "m1", displayName: "M1", kind: "chat" }],
        defaultModel: "m1",
        enabled: true,
      },
    });
    await invoke("profiles:create", {
      draft: {
        name: "E2E Worker",
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
    window.localStorage.setItem(
      "ffpane.ui-state",
      JSON.stringify({ state: { activeProjectId: entry.id }, version: 1 }),
    );
  }, projectDir);
  seedTasks(projectDir);
  await launched.page.reload();
  await launched.page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await launched.cleanup();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(fakeBinDir, { recursive: true, force: true });
});

test("派发一轮后任务页在飞区呈现：角色 · 任务 · 开始时间 · 占用的可写范围", async () => {
  const { page } = launched;

  // 直调派发第一轮（假 codex 挂起 → 轮长期在飞）；受理即真实登记
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
        input: { kind: "worker-task", taskId: "task-par-a" },
      });
    },
    { dir: projectDir, turnId: TURN_A },
  );
  expect(ack.accepted).toBe(true);

  await gotoRoute(page, "/tasks");
  await expect(page.getByText("Turns in flight")).toBeVisible();
  await expect(page.getByText("Worker", { exact: true })).toBeVisible();
  await expect(page.getByText("task-par-a", { exact: true })).toBeVisible();
  await expect(page.getByText("writes: src/app")).toBeVisible();
  // 任务已被派发推进 running：Running 列计数为 1
  await expect(page.getByText("parallel seed task A")).toBeVisible();
});

test("派发相交任务被拒绝：冲突明细人可读（在飞任务 + 两条路径 + 相交关系）+ 重试入口；任务未被推进", async () => {
  const { page } = launched;

  // task-par-b 是唯一 pending 任务，看板上唯一的 Dispatch 按钮属于它
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();

  await expect(page.getByText(/rejected for parallel run/)).toBeVisible();
  await expect(
    page.getByText(/"src\/app\/sub" and in-flight task task-par-a's "src\/app" are nested/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry dispatch" })).toBeVisible();
  // 被拒的任务保持 pending（dispatchTask 未发生）：Dispatch 按钮仍在、无 Retry（failed）态
  await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
});

test("等待后重试的自然路径：取消在飞轮 → 在飞区清空 → 重试派发即受理", async () => {
  const { page } = launched;

  await page.evaluate(async (turnId: string) => {
    // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
    await (window as any).ffpane.invoke("session:cancel", { turnId });
  }, TURN_A);

  // 轮结束（cancelled）→ 事件桥递增 endedTurnSeq → 在飞区重取为空（树杀需要几秒宽限）
  await expect(page.getByText("task-par-a", { exact: true })).toBeHidden({ timeout: 20_000 });

  // 相交轮已释放：重试派发受理，随即导航进会话页跟进执行（§12 派发即进入执行视图）
  await page.getByRole("button", { name: "Retry dispatch" }).click();
  await expect(page.getByText(/rejected for parallel run/)).toBeHidden({ timeout: 15_000 });
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 15_000 })
    .toBe("#/session");

  // 回任务页：在飞区呈现的是新受理的 task-par-b
  await gotoRoute(page, "/tasks");
  await expect(page.getByText("Turns in flight")).toBeVisible();
  await expect(page.getByText("task-par-b", { exact: true })).toBeVisible();
});
