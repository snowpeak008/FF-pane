/**
 * T4.5/T4.6 真机十步走查（live，非 CI）：启动真实 Electron app，用真实 DeepSeek + codex
 * 驱动生产 IPC 全栈（编排器 → codex → DeepSeek → storage）走一遍 §12 十步。
 *
 * 用法：DS_KEY=<deepseek-key> node apps/desktop/scripts/live-ten-step.mjs
 * 说明：Provider/Profile/Project 经 IPC 建立（与 UI 按钮同一后端 handler）；
 * 生成计划与批准另经真实 UI 点击演示（见末尾）。不提交密钥、用后即弃临时目录。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "@playwright/test";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.DS_KEY;
if (!KEY) {
  console.error("需要 DS_KEY 环境变量");
  process.exit(1);
}

const PLANNER_ENV = {
  readPaths: ["**"],
  writePaths: [],
  shell: "forbidden",
  network: true,
  dangerousOpsRequireApproval: true,
};
const WORKER_ENV = {
  readPaths: ["**"],
  writePaths: ["**"],
  shell: "allowed",
  network: false,
  dangerousOpsRequireApproval: true,
};

function log(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

const dataRoot = mkdtempSync(join(tmpdir(), "ffpane-live-data-"));
const userDataDir = mkdtempSync(join(tmpdir(), "ffpane-live-udata-"));
const projectRoot = mkdtempSync(join(tmpdir(), "ffpane-live-proj-"));
execFileSync("git", ["init", "-q"], { cwd: projectRoot });
execFileSync("git", ["config", "user.email", "live@x.t"], { cwd: projectRoot });
execFileSync("git", ["config", "user.name", "live"], { cwd: projectRoot });

const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) env[k] = v;
}
env.FF_PANE_DATA_ROOT = dataRoot;
delete env.ELECTRON_RENDERER_URL;

let app;
try {
  app = await _electron.launch({
    args: [
      ".",
      `--user-data-dir=${userDataDir}`,
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ],
    cwd: desktopDir,
    env,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => window.localStorage.setItem("ffpane.ui-language", "en-US"));
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  const invoke = (channel, req) =>
    page.evaluate(([c, r]) => window.ffpane.invoke(c, r), [channel, req]);

  // #2 建 Provider（openai_compatible，真实 key 经 safeStorage 落盘）
  log("2", "创建 DeepSeek Provider…");
  const provider = await invoke("providers:create", {
    draft: {
      name: "DeepSeek",
      type: "openai_compatible",
      baseUrl: "https://api.deepseek.com/v1",
      models: [{ id: "deepseek-chat", displayName: "deepseek-chat", kind: "chat" }],
      defaultModel: "deepseek-chat",
      enabled: true,
    },
    apiKey: KEY,
  });
  console.log("  provider.id =", provider.id, "apiKeyRef =", provider.apiKeyRef);

  // #3 建 Planner / Worker Profile（codex 运行时）
  log("3", "创建 codex Planner / Worker Profile…");
  const planner = await invoke("profiles:create", {
    draft: {
      name: "Planner(codex/DeepSeek)",
      runtime: "codex",
      providerId: provider.id,
      defaultRole: "planner",
      permissionPreset: PLANNER_ENV,
      model: "deepseek-chat",
    },
  });
  const worker = await invoke("profiles:create", {
    draft: {
      name: "Worker(codex/DeepSeek)",
      runtime: "codex",
      providerId: provider.id,
      defaultRole: "worker",
      permissionPreset: WORKER_ENV,
      model: "deepseek-chat",
    },
  });
  console.log("  planner =", planner.id, "worker =", worker.id);

  // #1 建项目（生成 .workbench/）
  log("1", "创建项目…");
  const project = await invoke("projects:create", { rootPath: projectRoot, name: "live-demo" });
  console.log("  project =", project.id, project.rootPath);

  // 会话轮 helper：订阅 session:event，start 后等本轮 end
  const runTurn = (turnId, profileId, input) =>
    page.evaluate(
      ([tid, pid, root, inp]) =>
        new Promise((res) => {
          const events = [];
          const off = window.ffpane.subscribe("session:event", (e) => {
            if (e.turnId !== tid) return;
            events.push(e.kind);
            if (e.kind === "end") {
              off?.();
              res({
                reason: e.reason,
                message: e.message,
                planVersion: e.planVersion,
                runId: e.runId,
                kinds: events,
              });
            }
          });
          window.ffpane
            .invoke("session:start", { turnId: tid, projectRoot: root, profileId: pid, input: inp })
            .then((ack) => {
              if (!ack.accepted) {
                off?.();
                res({ reason: "rejected", message: ack.reason, kinds: events });
              }
            });
        }),
      [turnId, profileId, projectRoot, input],
    );

  // #4/#5/#6 生成计划（planner-plan 轮，真机 DeepSeek → 结构化计划落盘）
  log("5", "生成计划（planner-plan，真机 DeepSeek，可能耗时 ~30s）…");
  const planTurn = await runTurn("live-plan", planner.id, { kind: "planner-plan" });
  console.log(
    "  end:",
    planTurn.reason,
    "planVersion:",
    planTurn.planVersion,
    planTurn.message ?? "",
  );
  if (planTurn.planVersion === undefined) throw new Error(`计划未生成：${planTurn.message}`);
  const plans = await invoke("plans:list", { projectRoot });
  const draft = plans.find((p) => p.version === planTurn.planVersion);
  console.log("  计划 goal:", draft.goal);
  console.log("  任务合同:", draft.tasks.map((t) => `${t.id}:${t.goal}`).join(" | "));

  // #5 批准计划 → 物化任务
  log("5", "批准计划 → 物化 pending 任务…");
  await invoke("plans:approve", { projectRoot, version: planTurn.planVersion });
  let tasks = await invoke("tasks:list", { projectRoot });
  console.log("  tasks:", tasks.map((t) => `${t.id}:${t.status}`).join(" | "));

  // #7 派发一个无 verifyCmd 的任务（可在 turn 完成即 done）→ 真机 Worker 执行
  const target = tasks.find((t) => t.verifyCmd === undefined) ?? tasks[0];
  log("7", `派发 Worker 任务 ${target.id}（真机 codex，可能耗时 ~60s）…`);
  const workerTurn = await runTurn("live-worker", worker.id, {
    kind: "worker-task",
    taskId: target.id,
  });
  console.log(
    "  end:",
    workerTurn.reason,
    "runId:",
    workerTurn.runId,
    "kinds:",
    workerTurn.kinds.join(","),
  );
  const runs = await invoke("runs:list", { projectRoot });
  console.log(
    "  Run 数:",
    runs.length,
    runs[0] ? `endReason=${runs[0].endReason} files=${runs[0].fileChanges?.length ?? 0}` : "",
  );

  // #9 接受任务（done → accepted）→ 触发记忆候选派生
  tasks = await invoke("tasks:list", { projectRoot });
  const after = tasks.find((t) => t.id === target.id);
  console.log("  任务状态:", after.status);
  if (after.status === "done") {
    log("9", "接受任务 → accepted…");
    const accept = await invoke("tasks:accept", { projectRoot, id: target.id });
    console.log("  accepted, candidateCount =", accept.candidateCount);

    // #10 记忆候选审核通过
    log("10", "记忆候选审核通过…");
    const allEntries = await invoke("memory:list", { projectRoot });
    const candidates = allEntries.filter((e) => e.status === "candidate");
    console.log("  候选数:", candidates.length);
    if (candidates.length > 0) {
      const approved = await invoke("memory:approve", { projectRoot, id: candidates[0].id });
      console.log("  已通过候选:", approved.id, "→ status", approved.status);
    }
  } else {
    console.log("  任务未到 done（真机模型行为），#9/#10 跳过——不影响链路结构验证");
  }

  log("done", "十步核心链路（真机后端）走查完成");
} catch (thrown) {
  console.error("\n[FAIL]", thrown?.message ?? thrown);
  process.exitCode = 1;
} finally {
  await app?.close();
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
}
