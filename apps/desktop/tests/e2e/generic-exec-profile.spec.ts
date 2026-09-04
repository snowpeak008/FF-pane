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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

let launched: LaunchedApp;
let projectDir: string;

const SENTINEL = "E2E-GX-OK";
const TASK_ID = "task-gx-echo";

/** 预写一个 pending 任务（无 verifyCmd：done 门槛走「报告非空」路径）。 */
function seedTask(projectRoot: string): void {
  const tasksDir = join(projectRoot, ".workbench", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(tasksDir, `task-${TASK_ID}.json`),
    JSON.stringify(
      {
        id: TASK_ID,
        planVersion: 1,
        goal: "echo sentinel via generic-exec",
        writeScope: [],
        forbidden: [],
        dependsOn: [],
        contextRefs: [],
        acceptance: ["sentinel printed"],
        status: "pending",
      },
      null,
      2,
    ),
    "utf8",
  );
}

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
        type: "cli_login",
        models: [{ id: "m1", displayName: "M1", kind: "chat" }],
        defaultModel: "m1",
        enabled: true,
      },
    });
    window.localStorage.setItem(
      "ffpane.ui-state",
      JSON.stringify({ state: { activeProjectId: entry.id }, version: 1 }),
    );
  }, projectDir);
  seedTask(projectDir);
  await launched.page.reload();
  await launched.page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await launched.cleanup();
  rmSync(projectDir, { recursive: true, force: true });
});

test("设置页建 generic-exec Profile：runtime 选中即出现命令配置区，保存后列表出现", async () => {
  const { page } = launched;
  await gotoRoute(page, "/settings");

  await page.getByRole("button", { name: "New profile" }).click();
  await page.locator("#profile-name").fill("E2E GX Runner");

  // 选中 generic-exec 前命令配置区不存在，选中后出现（条件渲染）
  await expect(page.locator("#profile-gx-command")).toBeHidden();
  await page.locator("#profile-runtime").selectOption("generic-exec");
  await expect(page.locator("#profile-gx-command")).toBeVisible();

  await page.locator("#profile-provider").selectOption({ label: "E2E GX Provider" });
  await page.locator("#profile-gx-command").fill("node");
  await page.locator("#profile-gx-delivery").selectOption("stdin");
  // 一行一个参数：node -e "<脚本>"（脚本忽略 stdin，打印哨兵后自然退出）
  await page.locator("#profile-gx-args").fill(`-e\nconsole.log("${SENTINEL}")`);

  await page.getByRole("button", { name: "Save", exact: true }).click();

  // 保存成功：行出现（exact 匹配行内名称，排除 toast 的 Saved "…"）
  await expect(page.getByText("E2E GX Runner", { exact: true })).toBeVisible();
});

test("派发 Worker 任务真跑通：Run(completed) 落库且 report 含哨兵，任务 done", async () => {
  const { page } = launched;

  const ack = await page.evaluate(
    async (args: { dir: string; taskId: string }) => {
      const invoke = (channel: string, req?: unknown) =>
        // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
        (window as any).ffpane.invoke(channel, req);
      const profiles = await invoke("profiles:list");
      const gx = profiles.find((p: { runtime: string }) => p.runtime === "generic-exec");
      return invoke("session:start", {
        turnId: "e2e-gx-turn-1",
        projectRoot: args.dir,
        profileId: gx.id,
        input: { kind: "worker-task", taskId: args.taskId },
      });
    },
    { dir: projectDir, taskId: TASK_ID },
  );
  expect(ack.accepted).toBe(true);

  // 轮次收尾后 Run 落库：completed + report 含哨兵（node 进程几百 ms 内退出，宽限给足）
  await expect
    .poll(
      () =>
        page.evaluate(async (dir: string) => {
          // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
          const runs = await (window as any).ffpane.invoke("runs:list", { projectRoot: dir });
          const run = runs.find(
            (r: { taskId: string; endReason?: string }) => r.taskId === "task-gx-echo",
          );
          return run === undefined ? undefined : { endReason: run.endReason, report: run.report };
        }, projectDir),
      { timeout: 20_000 },
    )
    .toMatchObject({ endReason: "completed", report: SENTINEL });

  // 任务推进 done（无 verifyCmd → 报告即证据，doneEvidence: report-unverified）
  const task = await page.evaluate(async (dir: string) => {
    // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
    const tasks = await (window as any).ffpane.invoke("tasks:list", { projectRoot: dir });
    return tasks.find((t: { id: string }) => t.id === "task-gx-echo");
  }, projectDir);
  expect(task).toMatchObject({ status: "done", doneEvidence: "report-unverified" });
});
