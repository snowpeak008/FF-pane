/**
 * 配置面点击核验：隔离数据根，点真实设置控件，对照落盘 / 显隐 / 过滤。
 * 只核验设置页上点得到的控件：Profile / 角色编辑框自 T10.12a 起不再挂载，
 * 中转来源的过滤规则改在「配置」编辑框上核验。
 * 用法：先有 out/main/index.js，再 `node apps/desktop/scripts/config-click-audit.mjs`
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

const results = [];
function pass(id, detail) {
  results.push({ id, ok: true, detail });
  console.log(`  PASS  ${id}  ${detail}`);
}
function fail(id, detail) {
  results.push({ id, ok: false, detail });
  console.log(`  FAIL  ${id}  ${detail}`);
}

const dataRoot = mkdtempSync(join(tmpdir(), "ffpane-cfg-data-"));
const userDataDir = mkdtempSync(join(tmpdir(), "ffpane-cfg-udata-"));
const projectDir = mkdtempSync(join(tmpdir(), "ffpane-cfg-proj-"));
execFileSync("git", ["init", "-q"], { cwd: projectDir });

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
const WORKER_ENV = {
  readPaths: ["**"],
  writePaths: ["**"],
  shell: "allowed",
  network: false,
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
  await page.waitForTimeout(300);
}

async function invoke(channel, req) {
  return page.evaluate(([c, r]) => window.ffpane.invoke(c, r), [channel, req]);
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

  const project = await invoke("projects:create", { name: "Cfg Audit", rootPath: projectDir });
  await page.evaluate((id) => {
    window.localStorage.setItem(
      "ffpane.ui-state",
      JSON.stringify({ state: { activeProjectId: id }, version: 1 }),
    );
  }, project.id);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  await gotoRoute("/settings");
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor({ timeout: 15_000 });

  // 1 主题点击当场改 html
  await page.locator("#setting-theme").selectOption("dark");
  await page.waitForTimeout(200);
  const darkOn = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  const themeSaved = await page.evaluate(() => window.localStorage.getItem("ffpane.ui-theme"));
  if (darkOn && themeSaved === "dark") pass("theme-click", "选 Dark → html.dark + localStorage");
  else fail("theme-click", `dark=${darkOn} saved=${themeSaved}`);
  await page.locator("#setting-theme").selectOption("light");

  // 2 界面语言当场改标题；输出语言写 config.json
  await page.locator("#setting-ui-language").selectOption("zh-CN");
  await page.waitForTimeout(400);
  const zh = await page.getByRole("heading", { name: "设置", exact: true }).count();
  if (zh > 0) pass("ui-language-click", "选中文 → 标题变「设置」");
  else fail("ui-language-click", "切换后未见中文标题");
  await page.locator("#setting-output-language").selectOption("en-US");
  await page.waitForTimeout(300);
  const cfg = await invoke("config:get");
  if (cfg.aiOutputLanguage === "en-US")
    pass("output-language-click", "AI 输出语言写入 config.json");
  else fail("output-language-click", `config.aiOutputLanguage=${cfg.aiOutputLanguage}`);
  await page.locator("#setting-ui-language").selectOption("en-US");
  await page.waitForTimeout(400);

  // 3 窗口上限下拉即时落盘
  const windowLimit = page.locator("#setting-max-workbench-windows");
  const currentLimit = await windowLimit.inputValue();
  const nextLimit = await windowLimit
    .locator("option")
    .evaluateAll(
      (options, current) => options.map((o) => o.value).find((v) => v !== current),
      currentLimit,
    );
  await windowLimit.selectOption(nextLimit);
  await page.waitForTimeout(300);
  const cfg2 = await invoke("config:get");
  if (cfg2.maxWorkbenchWindows === Number(nextLimit))
    pass("window-limit-click", `窗口上限 ${nextLimit} 已落盘`);
  else fail("window-limit-click", `maxWorkbenchWindows=${cfg2.maxWorkbenchWindows}`);

  // 4 openai 只填名字可点保存 → 校验拒绝（按钮亮着，效果是报错）
  await page.getByRole("button", { name: "New provider" }).click();
  await page.getByTestId("provider-template-openai-official").click();
  await page.locator("#provider-name").fill("Bare OpenAI");
  const saveBtn = page.getByRole("button", { name: "Save", exact: true });
  const saveEnabled = await saveBtn.isEnabled();
  await saveBtn.click();
  // 校验经 IPC 往返才回来，点完立刻数会读到空
  const errLocator = page.locator("text=/baseUrl|apiKey|必须|must|required|Invalid/i");
  await errLocator
    .first()
    .waitFor({ timeout: 8_000 })
    .catch(() => {});
  const errVisible = await errLocator.count();
  if (saveEnabled && errVisible > 0) {
    pass("openai-save-bare", "保存钮可点，缺 baseUrl/密钥时校验挡住（未静默成功）");
  } else {
    fail("openai-save-bare", `enabled=${saveEnabled} errNodes=${errVisible}`);
  }
  await page.getByRole("button", { name: "Cancel" }).click();

  // 5 local-login：CLI 下拉不落盘；重开回到默认
  await page.getByRole("button", { name: "New provider" }).click();
  await page.getByTestId("provider-template-local-login").click();
  await page.locator("#provider-name").fill("CLI Probe");
  await page.locator("#provider-cli-runtime").waitFor({ timeout: 8_000 });
  await page.locator("#provider-cli-runtime").selectOption("claude-code");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("CLI Probe", { exact: true }).waitFor({ timeout: 8_000 });
  const cliProv = (await invoke("providers:list")).find((p) => p.name === "CLI Probe");
  if (cliProv && cliProv.runtime === undefined) {
    pass("cli-runtime-not-persisted", "Provider 无 runtime 字段；编辑器 CLI 选择只用于当场探测");
  } else {
    fail("cli-runtime-not-persisted", `意外字段 ${JSON.stringify(cliProv)}`);
  }
  await page.getByRole("button", { name: 'Edit "CLI Probe"' }).click();
  await page.locator("#provider-cli-runtime").waitFor({ timeout: 8_000 });
  const reopened = await page.locator("#provider-cli-runtime").inputValue();
  if (reopened === "codex")
    pass("cli-runtime-reset", "重开编辑器 CLI 下拉回到默认 codex（上次选 claude-code 丢失）");
  else fail("cli-runtime-reset", `重开值为 ${reopened}`);
  await page.getByRole("button", { name: "Cancel" }).click();

  // 6 本机登录来源（含已停用）不进配置的中转下拉；空 runtime 不能落盘
  await page.getByRole("button", { name: "New provider" }).click();
  await page.getByTestId("provider-template-local-login").click();
  await page.locator("#provider-name").fill("Disabled CLI");
  await page.locator("label:has-text('Enabled') input[type='checkbox']").uncheck();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Disabled CLI", { exact: true }).waitFor({ timeout: 8_000 });

  // 对照：合法中转来源必须在下拉里，否则「不在」的判据是空转。走界面新建，同用户路径
  await page.getByRole("button", { name: "New provider" }).click();
  await page.getByTestId("provider-template-anthropic-compatible").click();
  await page.locator("#provider-name").fill("Relay Control");
  await page.locator("#provider-baseurl").fill("https://relay.example.com");
  await page.locator("#provider-apikey").fill("sk-audit-not-real");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Relay Control", { exact: true }).waitFor({ timeout: 8_000 });

  /** 打开新建配置，切 Claude 中转，数下拉里的两个来源后关掉。 */
  async function countRelayOptions() {
    await page.getByRole("button", { name: "New config" }).click();
    await page.getByTestId("config-claude-mode").selectOption("relay");
    const relaySelect = page.getByTestId("config-claude-provider");
    await relaySelect.waitFor({ timeout: 8_000 });
    const control = await relaySelect.locator("option", { hasText: "Relay Control" }).count();
    const disabled = await relaySelect.locator("option", { hasText: "Disabled CLI" }).count();
    await page.getByRole("button", { name: "Cancel" }).click();
    return { control, disabled };
  }

  // 同页刚建的来源，不重进设置页就该出现在配置的中转下拉里
  const fresh = await countRelayOptions();
  if (fresh.control > 0) {
    pass("config-provider-list-fresh", "同页新建的中转来源立刻出现在配置下拉里");
  } else {
    fail(
      "config-provider-list-fresh",
      "同页新建的中转来源不在配置下拉里：ConfigsSection 只在挂载时拉一次 providers:list，要离开设置页再回来才看得到",
    );
  }

  // 重进设置页拿到最新来源后，再判过滤规则
  await gotoRoute("/projects");
  await gotoRoute("/settings");
  await page.getByRole("button", { name: "New config" }).waitFor({ timeout: 15_000 });
  const relisted = await countRelayOptions();
  if (relisted.control === 0) {
    fail("disabled-still-listed", "重进后对照来源 Relay Control 仍不在中转下拉里，判据无效");
  } else if (relisted.disabled === 0) {
    pass("disabled-still-listed", "配置的中转下拉不列出本机 CLI 来源（含已停用）");
  } else {
    fail("disabled-still-listed", "配置的中转下拉仍出现本机 CLI 来源");
  }

  const disabledProv = (await invoke("providers:list")).find((p) => p.name === "Disabled CLI");
  try {
    await invoke("profiles:create", {
      draft: {
        name: "Dead Runtime",
        runtime: "",
        providerId: disabledProv.id,
        defaultRole: "planner",
        connectionMode: "local_cli",
        permissionPreset: PLANNER_ENV,
      },
    });
    fail("empty-runtime-saved", "空 runtime 仍能落盘");
  } catch {
    pass("empty-runtime-saved", "空 runtime 被校验拒绝");
  }

  // 7 默认权限只预填新建，不改已有
  const existing = await invoke("profiles:create", {
    draft: {
      name: "Born Worker",
      runtime: "codex",
      defaultRole: "worker",
      connectionMode: "local_cli",
      permissionPreset: WORKER_ENV,
    },
  });
  const before = await invoke("config:get");
  await invoke("config:update", {
    defaultPermissionPreset: { ...WORKER_ENV, writePaths: ["docs/**"] },
  });
  const reread = (await invoke("profiles:list")).find((p) => p.id === existing.id);
  if (JSON.stringify(reread.permissionPreset.writePaths) !== JSON.stringify(["docs/**"])) {
    pass("default-perm-not-retroactive", "改默认权限不回写已有 Profile（只影响下次新建预填）");
  } else {
    fail("default-perm-not-retroactive", "已有 Profile 被默认权限改写");
  }
  await invoke("config:update", { defaultPermissionPreset: before.defaultPermissionPreset });

  // 8 配对无守卫：openai-compatible 模板的 Provider + claude-code Runtime 可以保存
  const apiProv = await invoke("providers:create", {
    draft: {
      name: "Fake API",
      templateId: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      models: [{ id: "m1", label: "M1", kind: "chat" }],
      defaultModelId: "m1",
      enabled: true,
    },
    apiKey: "sk-audit-not-real",
  });
  const mixed = await invoke("profiles:create", {
    draft: {
      name: "Mixed Pair",
      runtime: "claude-code",
      providerId: apiProv.id,
      model: "m1",
      defaultRole: "planner",
      connectionMode: "relay",
      permissionPreset: PLANNER_ENV,
    },
  });
  pass(
    "pairing-unguarded",
    `中转 + claude-code 可落盘（${mixed.id}）；派发注入 ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL`,
  );
} catch (thrown) {
  fail("crash", thrown?.message ?? String(thrown));
} finally {
  if (app !== undefined) {
    try {
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 20_000))]);
    } catch {
      app.process()?.kill();
    }
  }
  rmSync(dataRoot, { recursive: true, force: true, maxRetries: 3 });
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
  rmSync(projectDir, { recursive: true, force: true, maxRetries: 3 });
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n点击核验：${results.length - failed.length} 过 / ${failed.length} 失败 / 共 ${results.length}`,
);
if (failed.length > 0) process.exitCode = 1;
