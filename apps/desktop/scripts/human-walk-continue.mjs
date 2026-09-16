/**
 * 人类习惯走查续集：建档开聊之后，生成计划、批准、改执行者强度、派发。
 * 可见窗口、中文界面。隔离数据根，不碰真实 ~/.aiworkbench。
 *
 * 用法：先有 out/main/index.js，再 `node apps/desktop/scripts/human-walk-continue.mjs`
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "@playwright/test";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mainJs = join(desktopDir, "out", "main", "index.js");
if (!existsSync(mainJs)) {
  console.error("缺少构建产物，先跑 pnpm --filter @ff-pane/desktop run build");
  process.exit(1);
}

const shotDir = resolve(desktopDir, "../../docs/验收记录/human-walk-2026-09-16");
mkdirSync(shotDir, { recursive: true });

const LIVE_TURN_MS = 180_000;
const CLEANUP_MS = 30_000;
const PAUSE_MS = 600;

const results = [];
function pass(id, detail) {
  results.push({ id, ok: true, detail });
  console.log(`  PASS  ${id}  ${detail}`);
}
function fail(id, detail) {
  results.push({ id, ok: false, detail });
  console.log(`  FAIL  ${id}  ${detail}`);
}

const dataRoot = mkdtempSync(join(tmpdir(), "ffpane-human2-data-"));
const userDataDir = mkdtempSync(join(tmpdir(), "ffpane-human2-udata-"));
const projectDir = mkdtempSync(join(tmpdir(), "ffpane-human2-proj-"));
execFileSync("git", ["init", "-q"], { cwd: projectDir });
execFileSync("git", ["config", "user.email", "human@x.t"], { cwd: projectDir });
execFileSync("git", ["config", "user.name", "human"], { cwd: projectDir });
writeFileSync(join(projectDir, "README.md"), "# 周末笔记\n\n先空着。\n", "utf8");

const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) env[key] = value;
}
env.FF_PANE_DATA_ROOT = dataRoot;
delete env.ELECTRON_RENDERER_URL;

/** @type {import('@playwright/test').ElectronApplication | undefined} */
let app;
/** @type {import('@playwright/test').Page | undefined} */
let page;
let shotIndex = 0;

async function pause(ms = PAUSE_MS) {
  await page.waitForTimeout(ms);
}

async function shot(name) {
  shotIndex += 1;
  const file = join(shotDir, `${String(shotIndex).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function invoke(channel, req) {
  return page.evaluate(([c, r]) => window.ffpane.invoke(c, r), [channel, req]);
}

async function waitTurnEnd(budget = LIVE_TURN_MS) {
  let watchPerms = true;
  const allowLoop = (async () => {
    while (watchPerms) {
      const allow = page.getByRole("button", { name: "允许" });
      if ((await allow.count()) > 0) {
        await allow.click().catch(() => undefined);
      }
      await page.waitForTimeout(800);
    }
  })().catch(() => undefined);
  const ended = await page.evaluate(
    ([ms]) =>
      new Promise((res) => {
        const kinds = [];
        let settled = false;
        const finish = (payload) => {
          if (settled) return;
          settled = true;
          off?.();
          res(payload);
        };
        const off = window.ffpane.subscribe("session:event", (e) => {
          kinds.push(e.kind);
          if (e.kind === "end" || e.kind === "error") {
            finish({ reason: e.reason ?? e.kind, message: e.message ?? "", kinds });
          }
        });
        setTimeout(() => finish({ reason: "timeout", message: `no end in ${ms}ms`, kinds }), ms);
      }),
    [budget],
  );
  watchPerms = false;
  await allowLoop;
  return ended;
}

try {
  app = await _electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`, "--lang=zh-CN"],
    cwd: desktopDir,
    env,
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await pause(800);

  await app.evaluate(async ({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, projectDir);

  await page.getByRole("button", { name: "新建项目" }).click();
  await pause();
  await page.getByRole("button", { name: "选择目录…" }).click();
  await page.locator("#create-project-name").fill("周末笔记");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("button", { name: /^周末笔记/ }).waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: /^周末笔记/ }).click();
  try {
    await page.getByRole("button", { name: "去会话页" }).click({ timeout: 8_000 });
  } catch {
    await page.getByRole("link", { name: "会话" }).click();
  }
  await page.getByRole("button", { name: "去设置" }).click();
  await page.getByRole("heading", { name: "设置", exact: true }).waitFor({ timeout: 10_000 });

  await page.getByRole("button", { name: "新建 Profile" }).click();
  await page.locator("#profile-name").fill("我的规划者");
  await page.locator("#profile-connection").selectOption("local_cli");
  await page.locator("#profile-runtime").selectOption("claude-code");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("我的规划者", { exact: true }).waitFor({ timeout: 10_000 });

  await page.getByRole("button", { name: "新建 Profile" }).click();
  await page.locator("#profile-name").fill("我的执行者");
  await page.locator("#profile-connection").selectOption("local_cli");
  await page.locator("#profile-runtime").selectOption("codex");
  await page.locator("#profile-role").selectOption("worker");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("我的执行者", { exact: true }).waitFor({ timeout: 10_000 });
  pass("setup", "项目 + 规划者 + 执行者就位");

  await page.getByRole("link", { name: "会话" }).click();
  await page.getByLabel("会话输入").waitFor({ timeout: 10_000 });
  await page.locator("#session-reasoning-effort").selectOption("low");
  await page.getByLabel("会话输入").fill(
    "帮我在这个目录新建 notes.md，文件里只写一行：周末先把书桌收拾一下。不要改 README，不要做别的。",
  );
  await shot("01-说出需求");
  const chatWait = waitTurnEnd();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const chatEnd = await chatWait;
  if (chatEnd.reason === "completed" || chatEnd.reason === "succeeded") {
    pass("ask", `说完需求，规划者回了 ${chatEnd.reason}`);
  } else {
    fail("ask", `${chatEnd.reason} ${chatEnd.message}`);
  }
  await pause(800);
  await shot("02-讨论完");

  const planWait = waitTurnEnd();
  await page.getByRole("button", { name: "生成计划" }).click();
  pass("clicked-plan", "点了生成计划（不靠输入框里的草稿）");
  const planEnd = await planWait;
  if (planEnd.reason === "completed" || planEnd.reason === "succeeded") {
    pass("plan-turn", `计划轮 ${planEnd.reason} kinds=${planEnd.kinds.join(",")}`);
  } else {
    fail("plan-turn", `${planEnd.reason} ${planEnd.message}`);
  }
  await pause(800);
  await shot("03-计划轮结束");

  try {
    await page.getByRole("button", { name: "查看计划" }).waitFor({ timeout: 8_000 });
    await page.getByRole("button", { name: "查看计划" }).click();
    pass("view-plan-toast", "点 toast「查看计划」");
  } catch {
    await page.getByRole("link", { name: "计划" }).click();
    pass("view-plan-toast", "toast 未见，改点侧栏计划");
  }
  await pause();
  await page.getByRole("heading", { name: "计划", exact: true }).waitFor({ timeout: 10_000 });
  const plans = await invoke("plans:list", { projectRoot: projectDir });
  const latestPlan = Array.isArray(plans) ? plans[0] : undefined;
  if (latestPlan !== undefined) {
    pass(
      "plan-on-page",
      `计划页有 v${latestPlan.version} ${latestPlan.status} 任务${latestPlan.tasks?.length ?? 0}个`,
    );
  } else {
    fail("plan-on-page", "计划页没有落盘的计划");
  }
  await shot("04-计划页");

  const approveBtn = page.getByRole("button", { name: "批准", exact: true });
  if ((await approveBtn.count()) > 0) {
    await approveBtn.click();
    await pause(800);
    const after = await invoke("plans:list", { projectRoot: projectDir });
    const approved = Array.isArray(after)
      ? after.find((p) => p.status === "approved")
      : undefined;
    if (approved !== undefined) pass("approve", `批准了 v${approved.version}`);
    else fail("approve", `点了批准，状态=${JSON.stringify(after?.[0]?.status)}`);
  } else {
    fail("approve", "计划页没有批准按钮（可能不是草稿）");
  }
  await shot("05-批准后");

  await page.getByRole("link", { name: "任务" }).click();
  await pause(800);
  const tasks = await invoke("tasks:list", { projectRoot: projectDir });
  const pending = (Array.isArray(tasks) ? tasks : []).filter((t) => t.status === "pending");
  if (pending.length > 0) {
    pass("tasks-ready", `任务页有 ${pending.length} 条待办：${pending.map((t) => t.goal).join(" / ")}`);
  } else {
    fail("tasks-ready", `批准后没有 pending 任务 ${JSON.stringify(tasks)}`);
  }
  await shot("06-任务看板");

  if (pending[0] !== undefined) {
    const task = pending[0];
    const effortSel = page.getByTestId(`task-reasoning-effort-${task.id}`);
    if ((await effortSel.count()) > 0) {
      await effortSel.selectOption("high");
      await pause(500);
      const listed = await invoke("tasks:list", { projectRoot: projectDir });
      const updated = listed.find((t) => t.id === task.id);
      if (updated?.reasoningEffort === "high") pass("task-effort", `给「${task.goal}」安排执行者强度 high`);
      else fail("task-effort", `落盘=${updated?.reasoningEffort}`);
    } else {
      fail("task-effort", "任务卡片没有思考强度下拉");
    }

    const dispatchWait = waitTurnEnd();
    await page.getByRole("button", { name: "派发" }).first().click();
    pass("clicked-dispatch", "点了派发，跟去会话看执行");
    await page.getByRole("heading", { name: "会话", exact: true }).waitFor({ timeout: 15_000 }).catch(() => undefined);
    await shot("07-派发后会话");
    const workEnd = await dispatchWait;
    if (workEnd.reason === "completed" || workEnd.reason === "succeeded") {
      pass("worker-turn", `执行者 ${workEnd.reason} kinds=${workEnd.kinds.join(",")}`);
    } else {
      fail("worker-turn", `${workEnd.reason} ${workEnd.message}`);
    }
    await pause(800);
    await shot("08-执行结束");

    await page.getByRole("link", { name: "任务" }).click();
    await pause(800);
    const afterTasks = await invoke("tasks:list", { projectRoot: projectDir });
    const settled = afterTasks.find((t) => t.id === task.id);
    await shot("09-任务收场");
    const statusDetail = `任务 ${settled?.id} 状态=${settled?.status} failReason=${settled?.failReason ?? "无"} verifyCmd=${settled?.verifyCmd ?? "无"}`;
    if (settled?.status === "done") {
      pass("task-status", statusDetail);
    } else {
      fail("task-status", statusDetail);
    }

    const notesPath = join(projectDir, "notes.md");
    if (existsSync(notesPath)) {
      const body = readFileSync(notesPath, "utf8");
      pass("notes-file", `notes.md 已出现：${JSON.stringify(body).slice(0, 80)}`);
    } else {
      fail("notes-file", "目录里还没有 notes.md");
    }
  }

  await page.getByRole("link", { name: "执行记录" }).click();
  await pause(600);
  const runs = await invoke("runs:list", { projectRoot: projectDir });
  if (Array.isArray(runs) && runs.length > 0) {
    pass("runs", `执行记录 ${runs.length} 条 end=${runs[0]?.endReason} effort=${runs[0]?.reasoningEffort}`);
  } else {
    fail("runs", "执行记录是空的");
  }
  await shot("10-执行记录");
} catch (thrown) {
  fail("crash", thrown?.message ?? String(thrown));
  if (page !== undefined) await shot("crash").catch(() => undefined);
  process.exitCode = 1;
} finally {
  if (app !== undefined) {
    let timer;
    const outcome = await Promise.race([
      app.close().then(() => "closed"),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), CLEANUP_MS);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === "timeout") {
      app.process().kill();
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  rmSync(dataRoot, { recursive: true, force: true, maxRetries: 3 });
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
  rmSync(projectDir, { recursive: true, force: true, maxRetries: 3 });
}

const failed = results.filter((r) => !r.ok);
writeFileSync(
  join(shotDir, "结果.md"),
  [
    `# 人类走查续集 ${new Date().toISOString()}`,
    "",
    `汇总：${results.filter((r) => r.ok).length} 过 / ${failed.length} 失败 / 共 ${results.length}`,
    "",
    ...results.map((r) => `- ${r.ok ? "PASS" : "FAIL"} **${r.id}**：${r.detail}`),
    "",
  ].join("\n"),
  "utf8",
);
console.log(
  `\n续集走查：${results.filter((r) => r.ok).length} 过 / ${failed.length} 失败 / 共 ${results.length}`,
);
console.log(`截图：${shotDir}`);
if (failed.length > 0) process.exitCode = 1;
