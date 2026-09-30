/**
 * 按人类习惯的真机走查：可见窗口、中文界面、侧栏点击、跟引导去设置，
 * 再改思考强度并真发一轮。目录选择器无法由页面驱动，沿用 E2E 主进程打桩。
 *
 * 用法：先有 out/main/index.js，再 `node apps/desktop/scripts/human-walk.mjs`
 * 隔离数据根，不碰真实 ~/.aiworkbench。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "@playwright/test";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mainJs = join(desktopDir, "out", "main", "index.js");
if (!existsSync(mainJs)) {
  console.error("缺少构建产物 out/main/index.js，先跑 pnpm --filter @ff-pane/desktop run build");
  process.exit(1);
}

const shotDir = resolve(desktopDir, "../../docs/验收记录/human-walk-2026-09-15");
mkdirSync(shotDir, { recursive: true });

const LIVE_TURN_MS = 180_000;
const CLEANUP_MS = 30_000;
const PAUSE_MS = 700;

const results = [];
function pass(id, detail) {
  results.push({ id, ok: true, detail });
  console.log(`  PASS  ${id}  ${detail}`);
}
function fail(id, detail) {
  results.push({ id, ok: false, detail });
  console.log(`  FAIL  ${id}  ${detail}`);
}

const dataRoot = mkdtempSync(join(tmpdir(), "ffpane-human-data-"));
const userDataDir = mkdtempSync(join(tmpdir(), "ffpane-human-udata-"));
const projectDir = mkdtempSync(join(tmpdir(), "ffpane-human-proj-"));
execFileSync("git", ["init", "-q"], { cwd: projectDir });
execFileSync("git", ["config", "user.email", "human@x.t"], { cwd: projectDir });
execFileSync("git", ["config", "user.name", "human"], { cwd: projectDir });
writeFileSync(join(projectDir, "README.md"), "# 周末想整理的笔记\n\n先随便记两句。\n", "utf8");

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

try {
  app = await _electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`, "--lang=zh-CN"],
    cwd: desktopDir,
    env,
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await pause(1000);

  const htmlLang = await page.locator("html").getAttribute("lang");
  const heading = await page.getByRole("heading", { name: "项目列表" }).count();
  if (heading > 0 || htmlLang === "zh-CN") {
    pass("boot-zh", `中文界面 html.lang=${htmlLang}`);
  } else {
    fail("boot-zh", `未见中文项目列表 html.lang=${htmlLang}`);
  }
  await shot("01-刚打开");

  await page.getByText(/还没有项目/i).waitFor({ timeout: 10_000 });
  pass("empty-projects", "空项目列表，和第一次打开一样");

  await app.evaluate(async ({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, projectDir);

  await page.getByRole("button", { name: "新建项目" }).click();
  await pause();
  await page.getByRole("button", { name: "选择目录…" }).click();
  await page.locator("#create-project-path").waitFor({ state: "visible", timeout: 8_000 });
  const filledPath = await page.locator("#create-project-path").inputValue();
  if (filledPath.length > 0) pass("pick-dir", "选目录后路径回填");
  else fail("pick-dir", "路径仍空");

  await page.locator("#create-project-name").fill("周末笔记");
  await pause(400);
  await shot("02-新建项目对话框");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  try {
    await page.getByRole("button", { name: /^周末笔记/ }).waitFor({ timeout: 10_000 });
    pass("project-card", "项目卡片出现");
  } catch (error) {
    fail("project-card", error.message ?? String(error));
  }

  await page.getByRole("button", { name: /^周末笔记/ }).click();
  await pause(400);
  try {
    await page.getByRole("button", { name: "去会话页" }).waitFor({ timeout: 8_000 });
    await page.getByRole("button", { name: "去会话页" }).click();
    pass("open-then-chat", "点开项目卡片，再点 toast「去会话页」");
  } catch {
    await page.getByRole("link", { name: "会话" }).click();
    pass("open-then-chat", "点了项目，改走侧栏进会话");
  }
  await pause();
  await shot("03-会话-还没档案");

  try {
    await page.getByRole("button", { name: "去设置" }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "去设置" }).click();
    pass("first-use", "跟人一样点「去设置」");
  } catch (error) {
    fail("first-use", error.message ?? String(error));
  }
  await pause();
  await page.getByRole("heading", { name: "设置", exact: true }).waitFor({ timeout: 10_000 });
  await shot("04-设置");

  await page.getByRole("button", { name: "新建 Profile" }).click();
  await pause();
  await page.locator("#profile-name").fill("我的规划者");
  await page.locator("#profile-connection").selectOption("local_cli");
  await pause(300);
  await page.locator("#profile-runtime").selectOption("claude-code");
  await pause(300);
  try {
    await page.locator("#profile-reasoning-effort").waitFor({ state: "visible", timeout: 8_000 });
    await page.locator("#profile-reasoning-effort").selectOption("low");
    pass("profile-effort", "建规划者时把档案默认强度调到低");
  } catch (error) {
    fail("profile-effort", error.message ?? String(error));
  }
  await shot("05-新建规划者");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  try {
    await page.getByText("我的规划者", { exact: true }).waitFor({ timeout: 10_000 });
    pass("planner-saved", "规划者档案在列表里");
  } catch {
    fail("planner-saved", "保存后没看到「我的规划者」");
  }

  await page.getByRole("button", { name: "新建 Profile" }).click();
  await pause();
  await page.locator("#profile-name").fill("我的执行者");
  await page.locator("#profile-connection").selectOption("local_cli");
  await page.locator("#profile-runtime").selectOption("codex");
  await page.locator("#profile-role").selectOption("worker");
  await pause(300);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  try {
    await page.getByText("我的执行者", { exact: true }).waitFor({ timeout: 10_000 });
    pass("worker-saved", "执行者档案在列表里");
  } catch {
    fail("worker-saved", "保存后没看到「我的执行者」");
  }

  await page.getByRole("button", { name: "新建 Profile" }).click();
  await pause();
  await page.locator("#profile-connection").selectOption("relay");
  await pause(400);
  const relaySelect = await page.locator("select#profile-provider").count();
  const localHint = await page.getByText("本机 CLI 登录").count();
  if (relaySelect > 0) pass("try-relay", "好奇点开中转：出现网址来源下拉");
  else fail("try-relay", `中转下拉=${relaySelect} 本地提示=${localHint}`);
  await shot("06-试中转连法");
  await page.getByRole("button", { name: "取消" }).click();

  await page.getByRole("link", { name: "会话" }).click();
  await pause();
  await page.getByLabel("会话输入").waitFor({ timeout: 10_000 });
  const goSettings = await page.getByRole("button", { name: "去设置" }).count();
  if (goSettings === 0) pass("session-ready", "有规划者后引导消失，可以说话了");
  else fail("session-ready", "还在逼我去设置");

  const effort = page.locator("#session-reasoning-effort");
  await effort.waitFor({ state: "visible", timeout: 10_000 });
  await effort.selectOption("high");
  await pause(400);
  await effort.selectOption("medium");
  await pause(300);
  const picked = await effort.inputValue();
  if (picked === "medium") pass("fiddle-effort", "顶栏先改高再改中，跟人调档一样");
  else fail("fiddle-effort", `最后停在 ${picked}`);

  await page
    .getByLabel("会话输入")
    .fill("这是我的笔记目录。先用一句话回复：收到，再说半句你看见了什么。不要用工具。");
  await pause(500);
  await shot("07-准备发送");

  const endedPromise = page.evaluate(
    ([budget]) =>
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
            finish({
              reason: e.reason ?? e.kind,
              message: e.message ?? "",
              kinds,
            });
          }
        });
        setTimeout(
          () => finish({ reason: "timeout", message: `no end in ${budget}ms`, kinds }),
          budget,
        );
      }),
    [LIVE_TURN_MS],
  );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  pass("clicked-send", "点了发送");

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

  const ended = await endedPromise;
  watchPerms = false;
  await allowLoop;
  if (ended.reason === "completed" || ended.reason === "succeeded") {
    pass("live-chat", `规划者回了 end=${ended.reason} kinds=${ended.kinds.join(",")}`);
  } else {
    fail("live-chat", `end=${ended.reason} ${ended.message}`);
  }
  await pause(800);
  await shot("08-对话结束");

  const latest = await invoke("sessions:latest", { projectRoot: projectDir }).catch(() => null);
  const replay =
    latest === null || latest === undefined
      ? { entries: [] }
      : await invoke("sessions:transcript", {
          projectRoot: projectDir,
          sessionId: latest.id,
        }).catch(() => ({ entries: [] }));
  if ((replay.entries?.length ?? 0) > 0) {
    pass("replay", `回放 ${replay.entries.length} 条`);
  } else {
    fail("replay", "发完却没有回放");
  }

  const pages = [
    ["计划", "这个项目还没有计划"],
    ["任务", "还没有任务"],
    ["执行记录", "还没有执行记录"],
    ["记忆", null],
    ["知识库", null],
  ];
  for (const [label, emptyNeedle] of pages) {
    await page.getByRole("link", { name: label }).click();
    await pause(500);
    try {
      await page.getByRole("heading", { name: label, exact: true }).waitFor({ timeout: 8_000 });
      if (emptyNeedle !== null) {
        await page.getByText(emptyNeedle).waitFor({ timeout: 8_000 });
      }
      pass(`browse-${label}`, `点侧栏「${label}」，人会先看看空着没有`);
    } catch (error) {
      fail(`browse-${label}`, error.message ?? String(error));
    }
  }
  await shot("09-知识库");

  await page.getByRole("link", { name: "会话" }).click();
  await pause();
  const stillMedium = await page.locator("#session-reasoning-effort").inputValue();
  if (stillMedium === "medium") pass("effort-sticks", "逛一圈回来，思考强度还是中");
  else fail("effort-sticks", `回来变成 ${stillMedium}`);
  await shot("10-回来会话");
} catch (thrown) {
  fail("crash", thrown?.message ?? String(thrown));
  if (page !== undefined) {
    await shot("crash").catch(() => undefined);
  }
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
      console.warn("app.close() 超时，强杀");
      app.process().kill();
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  rmSync(dataRoot, { recursive: true, force: true, maxRetries: 3 });
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
  rmSync(projectDir, { recursive: true, force: true, maxRetries: 3 });
}

const failed = results.filter((r) => !r.ok);
const summary = [
  `# 人类习惯真机走查 ${new Date().toISOString()}`,
  "",
  `截图目录：\`${shotDir}\``,
  "",
  `汇总：${results.filter((r) => r.ok).length} 过 / ${failed.length} 失败 / 共 ${results.length}`,
  "",
  ...results.map((r) => `- ${r.ok ? "PASS" : "FAIL"} **${r.id}**：${r.detail}`),
  "",
].join("\n");
writeFileSync(join(shotDir, "结果.md"), summary, "utf8");
console.log(
  `\n人类走查：${results.filter((r) => r.ok).length} 过 / ${failed.length} 失败 / 共 ${results.length}`,
);
console.log(`截图：${shotDir}`);
if (failed.length > 0) process.exitCode = 1;
