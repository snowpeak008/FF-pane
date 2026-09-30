/**
 * T9.10 Planner 跟进回路（第一档）E2E：真实链路走通合同三件事。
 *
 * 1. ① Worker 轮落定 → 结算摘要写入项目级待汇报队列（planner-report.json 落盘可见）；
 * 2. ③ 任务页「让 Planner 复盘」按钮 → 用户显式发起 Planner 轮；
 * 3. ② 该轮 prompt 自动注入任务看板增量（含结算摘要）——假 codex 把 stdin 收到的
 *    提示词落盘，断言其中含注入节标题与摘要正文；
 * 4. ② 消费后出队：复盘轮成功开始后 planner-report.json 队列清空 + 基准落位。
 *
 * hermetic：不联网；假 codex 经 PATH 前置（secondary-panel.spec 同款注入方式）。
 * 替身行为：把 stdin（codex 适配器经 stdin 下发提示词）原样写进捕获文件后退出码 1
 * （无事件 → 适配器兜底 end(crashed)）——Worker 轮借此快速落定 failed，
 * Planner 复盘轮借此把「注入后的完整提示词」暴露给断言（轮自身 crashed 不影响
 * 消费语义：spawn 已发生即视为成功开始）。
 *
 * 红线面（无自动触发）由单测 planner-report-loop.test.ts 的行为守卫 + 源码钉子承担；
 * 本 spec 的复盘轮由真实按钮点击发起，本身就是「每步经用户」的实证。
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

let launched: LaunchedApp;
let projectDir: string;
let fakeBinDir: string;

const WORKER_TURN_ID = "e2e-planner-review-worker";
const CAPTURE_NAME = "captured-prompt.txt";

/**
 * 捕获 stdin 的假 codex：提示词原样写进捕获文件，退出码 1。
 * Windows 侧经 node 逐字节透传（cmd 的 findstr 会截断超长行 / 搅乱 UTF-8），
 * node 在测试机必然在 PATH（vitest/playwright 本身就跑在它上面）；POSIX 侧 cat。
 */
function seedFakeCodex(dir: string): void {
  const capturePath = join(dir, CAPTURE_NAME);
  const escaped = capturePath.replaceAll("\\", "\\\\");
  writeFileSync(
    join(dir, "codex.cmd"),
    `@echo off\r\nnode -e "const fs=require('fs');fs.writeFileSync('${escaped}',fs.readFileSync(0));"\r\nexit /b 1\r\n`,
    "utf8",
  );
  const posix = join(dir, "codex");
  writeFileSync(posix, `#!/bin/sh\ncat > "${capturePath}"\nexit 1\n`, "utf8");
  chmodSync(posix, 0o755);
}

/** 一个 pending 任务（供派发落定）。 */
function seedTask(projectRoot: string): void {
  const tasksDir = join(projectRoot, ".workbench", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(tasksDir, "task-task-pr-1.json"),
    JSON.stringify(
      {
        id: "task-pr-1",
        planVersion: 1,
        goal: "planner review seed task",
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

/** 读回项目的 planner-report.json（不存在返回 null）。 */
function readReportFile(
  projectRoot: string,
): { baseline?: unknown; queue: { taskId: string; summary: string }[] } | null {
  try {
    return JSON.parse(
      readFileSync(join(projectRoot, ".workbench", "planner-report.json"), "utf8"),
    ) as { baseline?: unknown; queue: { taskId: string; summary: string }[] };
  } catch {
    return null;
  }
}

test.beforeAll(async () => {
  fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-pr-bin-"));
  seedFakeCodex(fakeBinDir);
  launched = await launchApp({ pathPrepend: fakeBinDir });
  projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-pr-proj-"));
});

test.afterAll(async () => {
  await launched.cleanup();
  for (const dir of [projectDir, fakeBinDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Worker 落定 → 摘要入队落盘；复盘按钮发起 Planner 轮携带摘要；消费后出队 + 基准落位", async () => {
  const { page } = launched;

  // 应用就绪（首页渲染完成，preload 的 ffpane 桥可用）再动 IPC
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

  // 建档：项目 + cli_login Provider + Worker / Planner 两个 Profile
  await page.evaluate(async (dir: string) => {
    const invoke = (channel: string, req?: unknown) =>
      // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
      (window as any).ffpane.invoke(channel, req);
    const project = await invoke("projects:create", {
      name: "E2E PR Project",
      rootPath: dir,
    });
    const provider = await invoke("providers:create", {
      draft: {
        name: "E2E PR CLI",
        templateId: "local-login",
        models: [{ id: "m1", label: "M1", kind: "chat" }],
        defaultModelId: "m1",
        enabled: true,
      },
    });
    const preset = {
      readPaths: ["**"],
      writePaths: ["**"],
      shell: "allowed",
      network: false,
      dangerousOpsRequireApproval: true,
    };
    await invoke("profiles:create", {
      draft: {
        name: "E2E PR Worker",
        runtime: "codex",
        providerId: provider.id,
        defaultRole: "worker",
        permissionPreset: preset,
      },
    });
    await invoke("profiles:create", {
      draft: {
        name: "E2E PR Planner",
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
    window.localStorage.setItem(
      "ffpane.ui-state",
      JSON.stringify({ state: { activeProjectId: project.id }, version: 2 }),
    );
  }, projectDir);
  seedTask(projectDir);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  // ① 派发 Worker 轮：假 codex 退出码 1 → end(crashed) → 任务 failed →
  //   saveTask 落盘点入队结算摘要
  const ack = await page.evaluate(
    async (args: { dir: string; turnId: string }) => {
      const invoke = (channel: string, req?: unknown) =>
        // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
        (window as any).ffpane.invoke(channel, req);
      const profiles = (await invoke("profiles:list")) as { id: string; name: string }[];
      const worker = profiles.find((p) => p.name === "E2E PR Worker");
      return invoke("session:start", {
        turnId: args.turnId,
        projectRoot: args.dir,
        profileId: worker?.id,
        input: { kind: "worker-task", taskId: "task-pr-1" },
      });
    },
    { dir: projectDir, turnId: WORKER_TURN_ID },
  );
  expect(ack.accepted).toBe(true);

  // 摘要入队落盘可见（轮自行收尾，几秒内）：队列一条、指向该任务、正文是失败摘要
  await expect
    .poll(() => readReportFile(projectDir)?.queue.length ?? 0, { timeout: 20_000 })
    .toBe(1);
  const queued = readReportFile(projectDir);
  expect(queued?.queue[0]?.taskId).toBe("task-pr-1");
  expect(queued?.queue[0]?.summary).toContain("task-pr-1");
  expect(queued?.queue[0]?.summary).toContain("执行失败");
  expect(queued?.baseline).toBeUndefined();

  // ③ 任务页「让 Planner 复盘」按钮：用户显式动作发起 Planner 轮
  await gotoRoute(page, "/tasks");
  await page.getByRole("button", { name: "Planner debrief" }).click();

  // 受理成功即跳会话页
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 15_000 })
    .toBe("#/session");

  // ② 消费后出队 + 基准落位（受理成功 = spawn 已发生，消费当场发生）
  await expect
    .poll(
      () => {
        const report = readReportFile(projectDir);
        return report !== null && report.queue.length === 0 && report.baseline !== undefined;
      },
      { timeout: 20_000 },
    )
    .toBe(true);

  // ② 复盘轮携带摘要：假 codex 捕获的提示词（最后一轮 = Planner 轮覆盖写）
  //   含注入节标题、待汇报小节与摘要正文
  await expect
    .poll(
      () => {
        try {
          return readFileSync(join(fakeBinDir, CAPTURE_NAME), "utf8");
        } catch {
          return "";
        }
      },
      { timeout: 20_000 },
    )
    .toContain("# 任务看板增量");
  const capturedPrompt = readFileSync(join(fakeBinDir, CAPTURE_NAME), "utf8");
  expect(capturedPrompt).toContain("## 待汇报结算摘要");
  expect(capturedPrompt).toContain("task-pr-1");
  expect(capturedPrompt).toContain("执行失败");
  // 复盘指令正文也到场（按钮携带的用户层输入）
  expect(capturedPrompt).toContain("debrief");
});
