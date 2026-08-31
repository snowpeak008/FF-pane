/**
 * T6.6 真机验收（live，非 CI）：验证**真实 Worker 自己调用了知识库只读检索工具**，
 * 且这次调用与命中在执行记录里可见（开发计划 §9 T6.6 的验收条款）。
 *
 * 与 knowledge-mcp.spec.ts 的分工：那条 E2E 验证的是 sidecar 本身（拉起 → initialize →
 * tools/list → tools/call 一个来回），全程由测试代码扮演客户端；这里验证的是**模型在一轮
 * 受管执行里自主决定调用它**——中间隔着 codex 的 MCP 装配、DeepSeek 的函数调用、
 * 审计回读与 Run 落盘，那几段没有任何单测能覆盖到。
 *
 * 判据设计：知识库里种一条**模型不可能预先知道**的事实（随机口令），
 * 任务要求把它取出来写进文件。模型答对 ⇒ 它确实查了库，而不是编了一个像样的答案。
 *
 * 用法：DS_KEY=<deepseek-key> node apps/desktop/scripts/live-knowledge-tool.mjs
 * 密钥只经环境变量下发（§4.3），不入库、不进命令行、不落盘。
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

const MODEL = process.env.DS_MODEL ?? "deepseek-v4-flash";

/** 本次运行独有的口令：模型的训练语料里不可能有它，只能从知识库里查到。 */
const SECRET = `FFKB-${randomBytes(4).toString("hex").toUpperCase()}`;

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

const dataRoot = mkdtempSync(join(tmpdir(), "ffpane-kb-data-"));
const userDataDir = mkdtempSync(join(tmpdir(), "ffpane-kb-udata-"));
const projectRoot = mkdtempSync(join(tmpdir(), "ffpane-kb-proj-"));
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
const findings = [];
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

  log("1", `建 Provider / Profile / 项目（模型 ${MODEL}）…`);
  const provider = await invoke("providers:create", {
    draft: {
      name: "DeepSeek",
      type: "openai_compatible",
      baseUrl: "https://api.deepseek.com/v1",
      models: [{ id: MODEL, displayName: MODEL, kind: "chat" }],
      defaultModel: MODEL,
      enabled: true,
    },
    apiKey: KEY,
  });
  const planner = await invoke("profiles:create", {
    draft: {
      name: "Planner(codex/DeepSeek)",
      runtime: "codex",
      providerId: provider.id,
      defaultRole: "planner",
      permissionPreset: PLANNER_ENV,
      model: MODEL,
    },
  });
  const worker = await invoke("profiles:create", {
    draft: {
      name: "Worker(codex/DeepSeek)",
      runtime: "codex",
      providerId: provider.id,
      defaultRole: "worker",
      permissionPreset: WORKER_ENV,
      model: MODEL,
    },
  });
  await invoke("projects:create", { rootPath: projectRoot, name: "kb-tool-demo" });
  console.log("  provider =", provider.id, "worker =", worker.id);

  // 知识库种一条只有查库才知道的事实（顺带走一遍 T6.7 的手动新建通道）
  log("2", `写入知识库条目（口令 ${SECRET}）…`);
  const note = await invoke("knowledge:create-entry", {
    importId: "live-kb-1",
    title: "内部部署口令表",
    content:
      `本项目的灰度发布校验口令（deployment verification token）是 ${SECRET}。\n\n` +
      `该口令每次发布轮换一次，只登记在本表中；任何人不得凭记忆填写，必须查表获取。\n` +
      `其他环境的口令不在此表内，勿臆测。`,
    tags: ["部署", "口令"],
    source: { kind: "manual" },
  });
  console.log("  条目:", note.entryId, "块数:", note.report.chunks, "落盘:", note.path);
  if (note.report.chunks < 1) throw new Error("知识库条目没有产出块，后续检索无从谈起");

  // 检索一次自证：库里确实查得到（排除「模型查了但库是空的」这种混淆）
  const selfCheck = await invoke("knowledge:search", { query: SECRET });
  console.log("  自证检索命中数:", selfCheck.hits.length, "走了:", selfCheck.hits[0]?.sources);
  if (selfCheck.hits.length === 0) throw new Error("库里检索不到刚写入的口令，先修检索再谈工具");

  // 项目级开关：默认关（§8.3.5），这里显式打开
  log("3", "打开项目级 Agent 只读检索工具开关…");
  const before = await invoke("projects:get-settings", { projectRoot });
  await invoke("projects:update-settings", {
    projectRoot,
    patch: { knowledgeToolEnabled: true },
  });
  const after = await invoke("projects:get-settings", { projectRoot });
  console.log("  开关:", before.knowledgeToolEnabled, "→", after.knowledgeToolEnabled);
  if (before.knowledgeToolEnabled !== false)
    findings.push("开关默认值不是关闭（§8.3.5 要求默认关）");

  /** 会话轮 helper：订阅 session:event，start 后等本轮 end；顺带收集 knowledge-query。 */
  const runTurn = (turnId, profileId, input) =>
    page.evaluate(
      ([tid, pid, root, inp]) =>
        new Promise((res) => {
          const kinds = [];
          const queries = [];
          const commands = [];
          let text = "";
          const off = window.ffpane.subscribe("session:event", (e) => {
            if (e.turnId !== tid) return;
            kinds.push(e.kind);
            if (e.kind === "knowledge-query") queries.push(...e.queries);
            // 收集 Worker 实际跑了哪些命令：用来排除「口令是 grep 出来的」这个混淆——
            // 若它 grep 了数据根下的 notes 文件，那答对口令就不能证明工具起了作用
            if (e.kind === "command") commands.push(e.command ?? e.text ?? JSON.stringify(e));
            if (e.kind === "text") text += e.text ?? "";
            if (e.kind === "end") {
              off?.();
              res({
                reason: e.reason,
                message: e.message,
                planVersion: e.planVersion,
                runId: e.runId,
                kinds,
                queries,
                commands,
                text,
              });
            }
          });
          window.ffpane
            .invoke("session:start", { turnId: tid, projectRoot: root, profileId: pid, input: inp })
            .then((ack) => {
              if (!ack.accepted) {
                off?.();
                res({
                  reason: "rejected",
                  message: ack.reason,
                  kinds,
                  queries,
                  commands,
                  text: "",
                });
              }
            });
        }),
      [turnId, profileId, projectRoot, input],
    );

  // 计划轮：把任务合同压到「必须查库」这一件事上，免得模型自由发挥出一堆与本次验收无关的任务
  log("4", "生成计划（真机 DeepSeek，约 30s）…");
  const planTurn = await runTurn("live-kb-plan", planner.id, {
    kind: "planner-plan",
    text:
      "只出一个任务，不要拆分。该任务的目标是：使用知识库只读检索工具查出「灰度发布校验口令」" +
      "的取值，然后在项目根目录创建 token.txt，文件内容就是该口令本身（不要加任何其他文字）。" +
      "任务合同里必须写明：口令不得凭记忆或猜测填写，必须经知识库检索工具获取。不要设置验证命令。",
  });
  console.log(
    "  end:",
    planTurn.reason,
    "planVersion:",
    planTurn.planVersion,
    planTurn.message ?? "",
  );
  if (planTurn.planVersion === undefined) throw new Error(`计划未生成：${planTurn.message}`);

  await invoke("plans:approve", { projectRoot, version: planTurn.planVersion });
  const tasks = await invoke("tasks:list", { projectRoot });
  console.log("  任务:", tasks.map((t) => `${t.id}:${t.goal}`).join(" | "));
  const target = tasks.find((t) => t.verifyCmd === undefined) ?? tasks[0];
  if (target === undefined) throw new Error("计划批准后没有物化出任务");

  // Worker 轮：这一轮才是本次验收的正题
  log("5", `派发 Worker 任务 ${target.id}（真机 codex + MCP，约 60s）…`);
  const workerTurn = await runTurn("live-kb-worker", worker.id, {
    kind: "worker-task",
    taskId: target.id,
  });
  console.log("  end:", workerTurn.reason, "runId:", workerTurn.runId);
  console.log("  事件序:", workerTurn.kinds.join(","));
  console.log("  Worker 跑过的命令:");
  for (const c of workerTurn.commands) console.log("   ", String(c).slice(0, 200));

  // 判据一：模型自主调用了检索工具，且事件流里可见
  log("6", "核对判据…");
  console.log("  knowledge-query 事件里的调用数:", workerTurn.queries.length);
  for (const q of workerTurn.queries) {
    console.log(`    query=${JSON.stringify(q.query)} hits=${q.hitCount ?? q.hits?.length ?? "?"}`);
  }
  if (workerTurn.queries.length === 0) {
    findings.push("Worker 轮没有产生任何 knowledge-query 事件（模型未调用工具，或注入未生效）");
  }

  // 判据二：调用与命中落进 Run（执行记录页读的就是这里）
  const runs = await invoke("runs:list", { projectRoot });
  const run = runs.find((r) => r.id === workerTurn.runId) ?? runs[0];
  const recorded = run?.knowledgeQueries;
  console.log(
    "  Run 数:",
    runs.length,
    "Run.knowledgeQueries:",
    recorded === undefined ? "缺省（未开工具）" : recorded.length,
  );
  if (recorded === undefined) {
    findings.push("Run.knowledgeQueries 缺省——执行记录页整区不会显示，即工具未被装配进本轮");
  } else if (recorded.length === 0) {
    findings.push("Run.knowledgeQueries 为空数组（工具开了但一次没调用）");
  } else {
    console.log("    首条:", JSON.stringify(recorded[0]).slice(0, 300));
  }

  // 判据三：口令答对——证明它查的是库，而不是编了一个像样的答案
  let tokenFile;
  try {
    const names = readdirSync(projectRoot);
    const hit = names.find((n) => n.toLowerCase() === "token.txt");
    tokenFile = hit === undefined ? undefined : readFileSync(join(projectRoot, hit), "utf8").trim();
  } catch {
    tokenFile = undefined;
  }
  const answeredInText = workerTurn.text.includes(SECRET);
  console.log("  token.txt:", tokenFile ?? "（未创建）", "| 答复正文含口令:", answeredInText);
  if (tokenFile !== SECRET && !answeredInText) {
    findings.push(`口令未被正确取出（期望 ${SECRET}，token.txt=${tokenFile ?? "无"}）`);
  }

  log("结论", findings.length === 0 ? "T6.6 验收判据全部通过" : `有 ${findings.length} 项未通过`);
  for (const f of findings) console.log("  ✗", f);
  if (findings.length > 0) process.exitCode = 1;
} catch (thrown) {
  console.error("\n[FAIL]", thrown?.stack ?? thrown?.message ?? thrown);
  process.exitCode = 1;
} finally {
  await app?.close();
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
}
