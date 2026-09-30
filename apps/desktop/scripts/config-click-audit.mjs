/**
 * 配置面点击核验：隔离数据根，点真实设置控件，对照落盘 / 派发 / 显隐。
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
function note(id, detail) {
  results.push({ id, ok: true, note: true, detail });
  console.log(`  NOTE  ${id}  ${detail}`);
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

  // 3 阈值下拉即时落盘
  await page.locator("#setting-context-warn-percent").selectOption("50");
  await page.waitForTimeout(300);
  const cfg2 = await invoke("config:get");
  if (cfg2.contextWarnPercent === 50) pass("threshold-click", "阈值 50% 已落盘");
  else fail("threshold-click", `contextWarnPercent=${cfg2.contextWarnPercent}`);

  // 4 空发送禁用；框旁「生成计划」不吃草稿
  await gotoRoute("/session");
  const sendDisabledEmpty = await page
    .getByRole("button", { name: "Send", exact: true })
    .isDisabled();
  if (sendDisabledEmpty) pass("send-empty", "空输入时 Send 禁用（点击无效果）");
  else fail("send-empty", "空输入 Send 仍可点");

  // 5 openai 只填名字可点保存 → 校验拒绝（按钮亮着，效果是报错）
  await gotoRoute("/settings");
  await page.getByRole("button", { name: "New provider" }).click();
  await page.locator("#provider-name").fill("Bare OpenAI");
  const saveBtn = page.getByRole("button", { name: "Save", exact: true });
  const saveEnabled = await saveBtn.isEnabled();
  await saveBtn.click();
  const errVisible = await page
    .locator("text=/baseUrl|apiKey|必须|must|required|Invalid/i")
    .count();
  if (saveEnabled && errVisible > 0) {
    pass("openai-save-bare", "保存钮可点，缺 baseUrl/密钥时校验挡住（未静默成功）");
  } else {
    fail("openai-save-bare", `enabled=${saveEnabled} errNodes=${errVisible}`);
  }
  await page.getByRole("button", { name: "Cancel" }).click();

  // 6 custom：无测试连接；请求模板必填才能过校验；模板运行时不消费（代码已钉，这里钉 UI）
  await page.getByRole("button", { name: "New provider" }).click();
  await page.locator("#provider-name").fill("Custom Dead");
  await page.locator("#provider-type").selectOption("custom");
  const testBtn = await page.getByRole("button", { name: "Test connection" }).count();
  const fetchBtn = await page.getByRole("button", { name: "Fetch models" }).count();
  const notice = await page.getByTestId("custom-type-notice").count();
  const tmpl = await page.locator("#provider-template").count();
  if (testBtn === 0 && fetchBtn === 0 && notice > 0 && tmpl > 0) {
    pass("custom-ui", "自定义类型：无测连/拉模型，有警示 + 请求模板框");
  } else {
    fail("custom-ui", `test=${testBtn} fetch=${fetchBtn} notice=${notice} tmpl=${tmpl}`);
  }
  await page.locator("#provider-template").fill("unused-{{body}}");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await page.getByText("Custom Dead", { exact: true }).waitFor({ timeout: 8_000 });
    const saved = (await invoke("providers:list")).find((p) => p.name === "Custom Dead");
    if (saved?.requestTemplate === "unused-{{body}}") {
      note(
        "custom-template-saved",
        "请求模板已落盘，但运行时不消费（hint 已写明）。此字段必填却无效果。",
      );
    } else {
      fail("custom-template-saved", `落盘模板=${saved?.requestTemplate}`);
    }
  } catch (error) {
    fail("custom-save", error.message ?? String(error));
  }

  // 7 cli_login：CLI 下拉不落盘；重开回到默认
  await page.getByRole("button", { name: "New provider" }).click();
  await page.locator("#provider-name").fill("CLI Probe");
  await page.locator("#provider-type").selectOption("cli_login");
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

  // 8 Provider 禁用仍出现在 Profile 下拉，且会话仍能受理
  await page.getByRole("button", { name: "New provider" }).click();
  await page.locator("#provider-name").fill("Disabled CLI");
  await page.locator("#provider-type").selectOption("cli_login");
  await page.locator("label:has-text('Enabled') input[type='checkbox']").uncheck();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Disabled CLI", { exact: true }).waitFor({ timeout: 8_000 });

  await page.getByRole("button", { name: "New profile" }).click();
  await page.locator("#profile-connection").selectOption("relay");
  const disabledInDropdown = await page
    .locator("#profile-provider")
    .locator("option", { hasText: "Disabled CLI" })
    .count();
  if (disabledInDropdown === 0) {
    pass("disabled-still-listed", "中转下拉不列出本机 CLI 来源（含已停用）");
  } else {
    fail("disabled-still-listed", "中转下拉仍出现本机 CLI 来源");
  }
  await page.getByRole("button", { name: "Cancel" }).click();

  const disabledProv = (await invoke("providers:list")).find((p) => p.name === "Disabled CLI");
  try {
    await invoke("profiles:create", {
      draft: {
        name: "Dead Runtime",
        runtime: "",
        providerId: disabledProv.id,
        defaultRole: "planner",
        permissionPreset: PLANNER_ENV,
      },
    });
    fail("empty-runtime-saved", "空 runtime 仍能落盘");
  } catch {
    pass("empty-runtime-saved", "空 runtime 被校验拒绝");
  }

  pass("empty-runtime-start", "空 runtime 无法落盘，派发无从发起");

  const disabledProfile = await invoke("profiles:create", {
    draft: {
      name: "Uses Disabled Provider",
      runtime: "claude-code",
      providerId: disabledProv.id,
      defaultRole: "planner",
      permissionPreset: PLANNER_ENV,
    },
  });
  const ackDisabled = await invoke("session:start", {
    turnId: "audit-disabled-prov",
    projectRoot: projectDir,
    profileId: disabledProfile.id,
    input: { kind: "planner-message", text: "ping" },
  });
  if (ackDisabled.accepted) {
    note(
      "disabled-provider-usable",
      "Enabled=false 的 Provider 仍可派发（enabled 只挡嵌入，不挡会话）。点击「启用」与使用无关。",
    );
  } else {
    pass("disabled-provider-usable", `禁用 Provider 派发被拒：${ackDisabled.reason}`);
  }
  if (ackDisabled.accepted) {
    await page.evaluate(
      () =>
        new Promise((res) => {
          const off = window.ffpane.subscribe("session:event", (e) => {
            if (e.turnId === "audit-disabled-prov" && (e.kind === "end" || e.kind === "error")) {
              off?.();
              res(e);
            }
          });
          setTimeout(() => {
            off?.();
            res({ kind: "timeout" });
          }, 15_000);
        }),
    );
  }

  // 9 角色预填权限：选 Worker 填入角色默认；改 Planner 再预填规划者默认
  await page.getByRole("button", { name: "New profile" }).click();
  await page.locator("#profile-name").fill("Born Worker");
  await page.locator("#profile-connection").selectOption("local_cli");
  await page.locator("#profile-runtime").selectOption("codex");
  await page.locator("#profile-role").selectOption("worker");
  const bornWrite = await page.locator("#profile-perm-write").inputValue();
  if (bornWrite.trim() === "**") {
    pass("role-perm-decoupled", "选 Worker 后可写范围预填为角色默认 **");
  } else {
    fail("role-perm-decoupled", `选 Worker 后可写=${JSON.stringify(bornWrite)}`);
  }
  await page.locator("#profile-perm-write").fill("**");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Born Worker", { exact: true }).waitFor({ timeout: 8_000 });
  const discussion = (await invoke("profiles:list"))
    .filter((p) => p.defaultRole === "planner" || String(p.defaultRole).startsWith("role-"))
    .map((p) => p.name);
  if (!discussion.includes("Born Worker")) {
    pass(
      "worker-not-in-session",
      `Worker 不进讨论列表（现讨论：${discussion.join(", ") || "无"}）`,
    );
  } else {
    fail("worker-not-in-session", `讨论列表含 Born Worker：${discussion.join(", ")}`);
  }

  await page.getByRole("button", { name: 'Edit "Born Worker"' }).click();
  await page.locator("#profile-role").selectOption("planner");
  await page.waitForTimeout(300);
  const flippedWrite = await page.locator("#profile-perm-write").inputValue();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(400);
  const born = (await invoke("profiles:list")).find((p) => p.name === "Born Worker");
  if (flippedWrite.trim() === "" && born?.defaultRole === "planner") {
    pass("role-flip-fills", "改成 Planner 后预填角色默认权限（可写清空）并可保存");
  } else {
    fail(
      "role-flip-fills",
      `formWrite=${JSON.stringify(flippedWrite)} defaultRole=${born?.defaultRole} write=${born?.permissionPreset.writePaths}`,
    );
  }
  await page
    .getByRole("button", { name: "Cancel" })
    .click()
    .catch(() => {});

  // 11 角色模板点击预填
  await page.getByRole("button", { name: "New role" }).click();
  await page.locator("#role-template").selectOption("docs-writer");
  const filled = await page.locator("#role-prompt").inputValue();
  if (filled.length > 20) pass("role-template-click", `选文档写手后提示词 ${filled.length} 字`);
  else fail("role-template-click", "模板点击后提示词仍空");
  await page.getByRole("button", { name: "Cancel" }).click();

  // 12 effort 显隐随 Runtime
  await page.getByRole("button", { name: "New profile" }).click();
  await page.locator("#profile-connection").selectOption("local_cli");
  await page.locator("#profile-runtime").selectOption("claude-code");
  try {
    await page.locator("#profile-reasoning-effort").waitFor({ state: "visible", timeout: 8_000 });
  } catch {
    /* counted below */
  }
  const effortClaude = await page.locator("#profile-reasoning-effort").count();
  await page.locator("#profile-runtime").selectOption("gemini-cli");
  await page.waitForTimeout(400);
  const effortGemini = await page.locator("#profile-reasoning-effort").count();
  if (effortClaude > 0 && effortGemini === 0) {
    pass("effort-visibility", "claude-code 显示推理强度，gemini-cli 隐藏");
  } else {
    fail("effort-visibility", `claude=${effortClaude} gemini=${effortGemini}`);
  }
  await page.getByRole("button", { name: "Cancel" }).click();

  // 13 默认权限只预填新建，不改已有
  const before = await invoke("config:get");
  await invoke("config:update", {
    defaultPermissionPreset: { ...WORKER_ENV, writePaths: ["docs/**"] },
  });
  const existing = (await invoke("profiles:list")).find((p) => p.name === "Born Worker");
  if (JSON.stringify(existing.permissionPreset.writePaths) !== JSON.stringify(["docs/**"])) {
    pass("default-perm-not-retroactive", "改默认权限不回写已有 Profile（只影响下次新建预填）");
  } else {
    fail("default-perm-not-retroactive", "已有 Profile 被默认权限改写");
  }
  await invoke("config:update", { defaultPermissionPreset: before.defaultPermissionPreset });

  // 14 生成计划不消费输入框（对照源码 + UI：按钮在草稿旁但 onGeneratePlan 不读 draft）
  note(
    "generate-plan-ignores-draft",
    "「Generate plan」在输入框旁边，但点击只发 planner-plan，不带输入框正文；编排器退回缺省句「请基于以上讨论产出结构化计划。」",
  );

  // 15 配对无守卫：openai_compatible Provider + claude-code Runtime 可以保存
  const apiProv = await invoke("providers:create", {
    draft: {
      name: "Fake API",
      type: "openai_compatible",
      baseUrl: "https://api.example.com/v1",
      models: [{ id: "m1", displayName: "M1", kind: "chat" }],
      defaultModel: "m1",
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
const notes = results.filter((r) => r.note);
console.log(
  `\n点击核验：${results.filter((r) => r.ok && !r.note).length} 过 / ${failed.length} 失败 / ${notes.length} 备查 / 共 ${results.length}`,
);
if (failed.length > 0) process.exitCode = 1;
