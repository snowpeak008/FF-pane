/**
 * 脏测试走查：启动真实 Electron 生产构建，隔离数据根，按用户路径点一遍
 * 八个页面 + 空态 + 设置（连法二选一 / 角色模板 / Profile / effort / 阈值）+
 * 会话顶栏思考强度 + 任务卡片强度 + B 栏 + 命令面板 + 共享习惯 + 本机 CLI
 * 登录探测；若某家已登录则从会话页真点发送一轮极短 Planner 讨论，并以
 * sessions:transcript 验回放（讨论轮不铸 Run）。
 *
 * 用法（仓库根或本目录）：先 `pnpm --filter @ff-pane/desktop run build`，再
 * `node apps/desktop/scripts/dirty-walk.mjs`
 * 可选 DIRTY_SKIP_LIVE_TURN=1 跳过真机轮。
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

const SKIP_LIVE = process.env.DIRTY_SKIP_LIVE_TURN === "1";
const LIVE_TURN_MS = 180_000;
const CLEANUP_MS = 30_000;

const results = [];
function pass(id, detail) {
  results.push({ id, ok: true, detail });
  console.log(`  PASS  ${id}  ${detail}`);
}
function fail(id, detail) {
  results.push({ id, ok: false, detail });
  console.log(`  FAIL  ${id}  ${detail}`);
}
function skip(id, detail) {
  results.push({ id, ok: true, skipped: true, detail });
  console.log(`  SKIP  ${id}  ${detail}`);
}

const dataRoot = mkdtempSync(join(tmpdir(), "ffpane-dirty-data-"));
const userDataDir = mkdtempSync(join(tmpdir(), "ffpane-dirty-udata-"));
const projectDir = mkdtempSync(join(tmpdir(), "ffpane-dirty-proj-"));
execFileSync("git", ["init", "-q"], { cwd: projectDir });
execFileSync("git", ["config", "user.email", "dirty@x.t"], { cwd: projectDir });
execFileSync("git", ["config", "user.name", "dirty"], { cwd: projectDir });

const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) env[key] = value;
}
env.FF_PANE_DATA_ROOT = dataRoot;
delete env.ELECTRON_RENDERER_URL;

const PLANNER_ENV = {
  readPaths: ["**"],
  writePaths: [],
  shell: "forbidden",
  network: true,
  dangerousOpsRequireApproval: true,
};

/** @type {import('@playwright/test').ElectronApplication | undefined} */
let app;
/** @type {import('@playwright/test').Page | undefined} */
let page;

async function gotoRoute(route) {
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, `#${route}`);
  await page.waitForTimeout(250);
}

async function invoke(channel, req) {
  return page.evaluate(([c, r]) => window.ffpane.invoke(c, r), [channel, req]);
}

async function headingVisible(name) {
  const loc = page.getByRole("heading", { name, exact: true });
  await loc.waitFor({ state: "visible", timeout: 15_000 });
}

try {
  app = await _electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    cwd: desktopDir,
    env,
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => window.localStorage.setItem("ffpane.ui-language", "en-US"));
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  // 1 启动 + 桥
  const windows = app.windows().length;
  const hasBridge = await page.evaluate(() => typeof window.ffpane?.invoke === "function");
  if (windows === 1 && hasBridge) {
    pass("boot", "单窗 + window.ffpane 桥可用");
  } else {
    fail("boot", `windows=${windows} bridge=${hasBridge}`);
  }
  if (existsSync(join(dataRoot, ".reset-connection-mode-v1"))) {
    pass("wipe-marker", "启动后写下连法清场标记");
  } else {
    fail("wipe-marker", "未见 .reset-connection-mode-v1");
  }

  await headingVisible("Projects");
  await page.getByText(/No project yet/i).waitFor({ timeout: 10_000 });
  pass("projects-empty", "默认路由项目空态");

  const bBarHidden = await page.getByRole("button", { name: /Switch to project:/i }).count();
  if (bBarHidden === 0) pass("bbar-empty", "无项目时 B 栏切换器不出现");
  else fail("bbar-empty", `空列表仍有 ${bBarHidden} 条切换器`);

  // 2 建项目
  const project = await invoke("projects:create", { name: "Dirty Walk", rootPath: projectDir });
  await page.evaluate((id) => {
    window.localStorage.setItem(
      "ffpane.ui-state",
      JSON.stringify({ state: { activeProjectId: id }, version: 1 }),
    );
  }, project.id);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  const workbench = existsSync(join(projectDir, ".workbench"));
  if (workbench) pass("project-create", `.workbench 已生成 ${project.id}`);
  else fail("project-create", "未生成 .workbench");

  await gotoRoute("/projects");
  const switcher = page.getByRole("button", { name: "Switch to project: Dirty Walk" });
  try {
    await switcher.waitFor({ state: "visible", timeout: 10_000 });
    pass("bbar-visible", "有项目后 B 栏切换器可见");
  } catch {
    fail("bbar-visible", "有项目后看不到 B 栏切换器");
  }

  // 3 八角路由
  const routes = [
    ["/projects", "Projects"],
    ["/session", "Session"],
    ["/plan", "Plan"],
    ["/tasks", "Tasks"],
    ["/runs", "Runs"],
    ["/memory", "Memory"],
    ["/knowledge", "Knowledge"],
    ["/settings", "Settings"],
  ];
  for (const [route, title] of routes) {
    await gotoRoute(route);
    try {
      await headingVisible(title);
      const rootText = (await page.locator("#root").innerText()).trim();
      if (rootText.length > 0) pass(`route${route}`, `标题 ${title}，#root 非空`);
      else fail(`route${route}`, "标题在但 #root 空（疑似白屏）");
    } catch (error) {
      fail(`route${route}`, error.message ?? String(error));
    }
  }

  // 4 首用：无 Planner 时会话页引导
  await gotoRoute("/session");
  try {
    await page.getByRole("button", { name: "Go to Settings" }).waitFor({ timeout: 10_000 });
    pass("first-use-cta", "缺 Planner 时会话页有「去设置」");
  } catch {
    fail("first-use-cta", "未看到首用引导按钮");
  }

  // 5 设置面：Provider / 角色模板 / Profile+effort
  await gotoRoute("/settings");
  await headingVisible("Settings");

  await page.getByRole("button", { name: "New provider" }).click();
  await page.locator("#provider-name").fill("Dirty CLI");
  await page.locator("#provider-type").selectOption("cli_login");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await page.getByText("Dirty CLI", { exact: true }).waitFor({ timeout: 10_000 });
    pass("provider-cli", "cli_login Provider 建成");
  } catch {
    fail("provider-cli", "Provider 未出现在列表");
  }

  await page.getByRole("button", { name: "New role" }).click();
  await page.locator("#role-template").selectOption("docs-writer");
  const rolePrompt = await page.locator("#role-prompt").inputValue();
  if (rolePrompt.length > 0) pass("role-template", "选文档写手后提示词非空");
  else fail("role-template", "模板预填后提示词仍空");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await page.getByText("Docs writer", { exact: true }).waitFor({ timeout: 10_000 });
    pass("role-save", "模板角色落盘可见");
  } catch {
    fail("role-save", "角色列表未见 Docs writer");
  }

  await page.getByRole("button", { name: "New profile" }).click();
  await page.locator("#profile-name").fill("Dirty Planner");
  await page.locator("#profile-connection").selectOption("local_cli");
  await page.locator("#profile-runtime").selectOption("claude-code");
  try {
    await page.locator("#profile-reasoning-effort").waitFor({ state: "visible", timeout: 10_000 });
    await page.locator("#profile-reasoning-effort").selectOption("low");
    pass("effort-ui", "claude-code 出现推理强度下拉并可选 low");
  } catch (error) {
    fail("effort-ui", error.message ?? String(error));
  }
  await page.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await page.getByText("Dirty Planner", { exact: true }).waitFor({ timeout: 10_000 });
    pass("profile-planner", "Planner Profile 建成");
  } catch {
    fail("profile-planner", "Profile 列表未见 Dirty Planner");
  }

  await page.getByRole("button", { name: "New profile" }).click();
  await page.locator("#profile-name").fill("Dirty Worker");
  await page.locator("#profile-connection").selectOption("local_cli");
  await page.locator("#profile-runtime").selectOption("codex");
  await page.locator("#profile-role").selectOption("worker");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await page.getByText("Dirty Worker", { exact: true }).waitFor({ timeout: 10_000 });
    pass("profile-worker", "Worker Profile 建成");
  } catch {
    fail("profile-worker", "Profile 列表未见 Dirty Worker");
  }

  await page.getByRole("button", { name: "New profile" }).click();
  await page.locator("#profile-connection").selectOption("local_cli");
  await page.locator("#profile-provider").waitFor({ state: "visible", timeout: 8_000 });
  const localProviderTag = await page.locator("#profile-provider").evaluate((el) => el.tagName);
  const localProviderDisabled = await page.locator("#profile-provider").isDisabled();
  await page.locator("#profile-connection").selectOption("relay");
  await page.locator("select#profile-provider").waitFor({ state: "visible", timeout: 8_000 });
  const relayProviderTag = await page.locator("#profile-provider").evaluate((el) => el.tagName);
  const relayHidesGeneric =
    (await page.locator("#profile-runtime option", { hasText: "generic-exec" }).count()) === 0;
  if (
    localProviderTag === "INPUT" &&
    localProviderDisabled &&
    relayProviderTag === "SELECT" &&
    relayHidesGeneric
  ) {
    pass("connection-ui", "本地 CLI 只显示自动绑定来源；中转改选手动网址来源且无 generic-exec");
  } else {
    fail(
      "connection-ui",
      `local=${localProviderTag}/${localProviderDisabled} relay=${relayProviderTag} noGx=${relayHidesGeneric}`,
    );
  }
  await page
    .getByRole("button", { name: "Cancel" })
    .click()
    .catch(() => {});

  await page
    .getByRole("heading", { name: "Context threshold reminder" })
    .waitFor({ timeout: 10_000 });
  pass("context-warn", "设置页上下文阈值区可见");
  await page.getByRole("heading", { name: "Language" }).waitFor({ timeout: 10_000 });
  pass("language", "设置页语言区可见");

  // 6 会话页可发送
  await gotoRoute("/session");
  await headingVisible("Session");
  const goSettingsGone = await page.getByRole("button", { name: "Go to Settings" }).count();
  if (goSettingsGone === 0) pass("session-ready", "有 Planner 后引导消失");
  else fail("session-ready", "仍显示去设置引导");

  try {
    await page.getByLabel("Message composer").waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 5_000 });
    await page.getByRole("button", { name: "Generate plan" }).waitFor({ timeout: 5_000 });
    pass("session-composer", "输入框 / 发送 / 生成计划可见");
  } catch (error) {
    fail("session-composer", error.message ?? String(error));
  }

  try {
    const effort = page.locator("#session-reasoning-effort");
    await effort.waitFor({ state: "visible", timeout: 10_000 });
    await effort.selectOption("high");
    const picked = await effort.inputValue();
    if (picked === "high") pass("session-effort", "会话顶栏可改规划者思考强度为 high");
    else fail("session-effort", `选后值为 ${picked}`);
  } catch (error) {
    fail("session-effort", error.message ?? String(error));
  }

  const emptyBoards = [
    ["/plan", "Plan", "This project has no plan yet"],
    ["/tasks", "Tasks", "No tasks yet"],
    ["/runs", "Runs", "No run records yet"],
  ];
  for (const [route, title, needle] of emptyBoards) {
    await gotoRoute(route);
    try {
      await headingVisible(title);
      await page.getByText(needle).waitFor({ timeout: 10_000 });
      pass(`empty${route}`, "空态可见且可停留");
    } catch (error) {
      fail(`empty${route}`, error.message ?? String(error));
    }
  }
  await gotoRoute("/knowledge");
  try {
    await headingVisible("Knowledge");
    await page.getByRole("tab", { name: "Sources" }).waitFor({ timeout: 10_000 });
    await page.getByRole("tab", { name: "Sources" }).click();
    await page.getByText("The knowledge base is empty").waitFor({ timeout: 10_000 });
    pass("empty/knowledge", "来源空态可见且可停留");
  } catch (error) {
    fail("empty/knowledge", error.message ?? String(error));
  }

  const taskId = "dirty-effort";
  const tasksDir = join(projectDir, ".workbench", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(tasksDir, `task-${taskId}.json`),
    JSON.stringify({
      id: taskId,
      planVersion: 1,
      goal: "Dirty walk effort check",
      writeScope: [],
      forbidden: [],
      dependsOn: [],
      contextRefs: [],
      acceptance: ["ok"],
      status: "pending",
    }),
    "utf8",
  );
  await gotoRoute("/tasks");
  try {
    await headingVisible("Tasks");
    const taskEffort = page.getByTestId(`task-reasoning-effort-${taskId}`);
    await taskEffort.waitFor({ state: "visible", timeout: 10_000 });
    await taskEffort.selectOption("high");
    await page.waitForTimeout(400);
    const listed = await invoke("tasks:list", { projectRoot: projectDir });
    const seeded = listed.find((t) => t.id === taskId);
    if (seeded?.reasoningEffort === "high") {
      pass("task-effort", "任务页可改执行者思考强度并落盘 high");
    } else {
      fail("task-effort", `落盘=${JSON.stringify(seeded?.reasoningEffort)}`);
    }
  } catch (error) {
    fail("task-effort", error.message ?? String(error));
  }

  // 7 命令面板
  await page.keyboard.press("Control+K");
  try {
    await page.getByPlaceholder(/Search commands/i).waitFor({ state: "visible", timeout: 8_000 });
    pass("palette", "Ctrl+K 打开命令面板");
    await page.keyboard.press("Escape");
  } catch {
    fail("palette", "Ctrl+K 未见命令面板");
  }

  // 8 记忆页习惯区
  await gotoRoute("/memory");
  await headingVisible("Memory");
  try {
    const sharedTab = page.getByRole("tab", { name: "Shared memory" });
    await sharedTab.waitFor({ state: "visible", timeout: 15_000 });
    await sharedTab.click();
    await page.getByRole("button", { name: "Add habit" }).waitFor({ timeout: 10_000 });
    pass("habits", "记忆页共享习惯区可打开");
  } catch (error) {
    fail("habits", error.message ?? String(error));
  }
  try {
    await page.getByRole("button", { name: "Add habit" }).click();
    await page.locator("#habit-content").fill("Prefer short replies during dirty walks.");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByText("Prefer short replies during dirty walks.").waitFor({ timeout: 10_000 });
    pass("habit-create", "手写习惯可落盘并回显");
  } catch (error) {
    fail("habit-create", error.message ?? String(error));
  }

  // 9 本机 CLI 登录探测（真机）
  const runtimes = ["codex", "claude-code", "gemini-cli", "opencode", "grok-build"];
  const probes = {};
  for (const runtime of runtimes) {
    try {
      const view = await invoke("providers:probe-cli-login", { runtime });
      probes[runtime] = view.status;
      pass(`probe-${runtime}`, `${view.status} (${view.probedWith})`);
    } catch (error) {
      probes[runtime] = "error";
      fail(`probe-${runtime}`, error.message ?? String(error));
    }
  }

  // 10 真机极短讨论轮（可选）
  const liveRuntime =
    probes["claude-code"] === "logged_in"
      ? "claude-code"
      : probes.codex === "logged_in"
        ? "codex"
        : undefined;
  if (SKIP_LIVE) {
    skip("live-turn", "DIRTY_SKIP_LIVE_TURN=1");
    skip("session-replay", "未跑真机轮");
  } else if (liveRuntime === undefined) {
    skip("live-turn", `无已登录 CLI（探测=${JSON.stringify(probes)}）`);
    skip("session-replay", "无已登录 CLI，未跑真机轮");
  } else {
    const profiles = await invoke("profiles:list");
    let liveProfile = profiles.find(
      (p) => p.runtime === liveRuntime && p.defaultRole === "planner",
    );
    if (liveProfile === undefined) {
      const provider = (await invoke("providers:list")).find((p) => p.name === "Dirty CLI");
      liveProfile = await invoke("profiles:create", {
        draft: {
          name: `Dirty Live ${liveRuntime}`,
          runtime: liveRuntime,
          providerId: provider.id,
          defaultRole: "planner",
          permissionPreset: PLANNER_ENV,
        },
      });
    }
    await gotoRoute("/session");
    if (liveProfile.id !== undefined) {
      const discussion = page.getByLabel("Discussion profile");
      if ((await discussion.count()) > 0) {
        await discussion.selectOption(liveProfile.id);
      }
    }
    await page.locator("#session-reasoning-effort").selectOption("low");
    await page
      .getByLabel("Message composer")
      .fill("Reply with exactly: DIRTY_OK. No tools. One short sentence.");
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
            if (e.kind === "end") {
              finish({
                reason: e.reason,
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
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const ended = await endedPromise;
    if (ended.reason === "completed" || ended.reason === "succeeded") {
      pass("live-turn", `${liveRuntime} end=${ended.reason} kinds=${ended.kinds.join(",")}`);
    } else if (ended.reason === "rejected") {
      fail("live-turn", `轮次被拒：${ended.message}`);
    } else {
      fail("live-turn", `${liveRuntime} end=${ended.reason} ${ended.message}`);
    }

    const replay = await page.evaluate(async (root) => {
      const latest = await window.ffpane.invoke("sessions:latest", { projectRoot: root });
      if (latest === undefined || latest === null) return { sessions: 0, entries: 0 };
      const view = await window.ffpane.invoke("sessions:transcript", {
        projectRoot: root,
        sessionId: latest.id,
      });
      return { sessions: 1, entries: view.entries?.length ?? 0 };
    }, projectDir);
    if (replay.entries > 0) {
      pass("session-replay", `会话回放 ${replay.entries} 条（Planner 讨论不铸 Run，属预期）`);
    } else {
      fail("session-replay", `真机轮完成后回放为空 ${JSON.stringify(replay)}`);
    }
  }

  // 11 语言切换当场生效
  await gotoRoute("/settings");
  try {
    await page.locator("#setting-ui-language").selectOption("zh-CN");
    await page.waitForTimeout(400);
    const htmlLang = await page.locator("html").getAttribute("lang");
    const zhHeading = await page.getByRole("heading", { name: "设置" }).count();
    if (htmlLang === "zh-CN" || zhHeading > 0)
      pass("i18n-switch", `切换中文 html.lang=${htmlLang}`);
    else fail("i18n-switch", `切换后仍 en html.lang=${htmlLang}`);
  } catch (error) {
    fail("i18n-switch", error.message ?? String(error));
  }
} catch (thrown) {
  fail("crash", thrown?.message ?? String(thrown));
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
const skipped = results.filter((r) => r.skipped);
console.log(
  `\n脏测试汇总：${results.filter((r) => r.ok && !r.skipped).length} 过 / ${failed.length} 失败 / ${skipped.length} 跳过 / 共 ${results.length}`,
);
if (failed.length > 0) {
  process.exitCode = 1;
}
