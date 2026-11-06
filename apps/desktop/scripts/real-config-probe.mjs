/**
 * 对本机 ~/.aiworkbench 真实配置做只读核验 + 连接探测。
 * 不改 providers/profiles；不往用户项目里写任务。
 * 用法：`node apps/desktop/scripts/real-config-probe.mjs`
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "@playwright/test";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mainJs = join(desktopDir, "out", "main", "index.js");
if (!existsSync(mainJs)) {
  console.error("缺少构建产物");
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

const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) env[key] = value;
}
delete env.ELECTRON_RENDERER_URL;
delete env.FF_PANE_DATA_ROOT;

/** @type {import('@playwright/test').ElectronApplication | undefined} */
let app;
/** @type {import('@playwright/test').Page | undefined} */
let page;

async function invoke(channel, req) {
  return page.evaluate(([c, r]) => window.ffpane.invoke(c, r), [channel, req]);
}

function summarizeProvider(p) {
  return {
    name: p.name,
    type: p.type,
    enabled: p.enabled,
    hasBaseUrl: Boolean(p.baseUrl),
    defaultModel: p.defaultModel ?? null,
    modelCount: p.models?.length ?? 0,
    hasKey: Boolean(p.apiKeyRef),
  };
}

try {
  app = await _electron.launch({
    args: ["."],
    cwd: desktopDir,
    env,
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => window.localStorage.setItem("ffpane.ui-language", "en-US"));
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  const dataRoot = join(homedir(), ".aiworkbench");
  note("data-root", `未覆盖 FF_PANE_DATA_ROOT，读 ${dataRoot}`);

  const providers = await invoke("providers:list");
  const profiles = await invoke("profiles:list");
  const roles = await invoke("roles:list");
  const projects = await invoke("projects:list");

  console.log("  ---- providers ----");
  for (const p of providers) console.log("   ", JSON.stringify(summarizeProvider(p)));
  console.log("  ---- profiles ----");
  for (const p of profiles) {
    console.log(
      "   ",
      JSON.stringify({
        name: p.name,
        runtime: p.runtime,
        providerId: p.providerId,
        role: p.defaultRole,
        model: p.model ?? null,
        writePaths: p.permissionPreset.writePaths,
        shell: p.permissionPreset.shell,
        network: p.permissionPreset.network,
        effort: p.reasoningEffort ?? null,
      }),
    );
  }
  console.log("  ---- roles ----");
  for (const r of roles) console.log("   ", JSON.stringify({ name: r.name, id: r.id }));
  console.log("  ---- projects ----");
  for (const p of projects)
    console.log("   ", JSON.stringify({ name: p.name, rootPath: p.rootPath }));

  if (providers.length >= 1 && profiles.length >= 1) {
    pass(
      "real-loaded",
      `Provider ${providers.length} / Profile ${profiles.length} / 角色 ${roles.length} / 项目 ${projects.length}`,
    );
  } else {
    fail("real-loaded", "真实配置为空，无法核验");
  }

  const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
  const discussion = profiles.filter(
    (p) => p.defaultRole === "planner" || String(p.defaultRole).startsWith("role-"),
  );
  const workers = profiles.filter((p) => p.defaultRole === "worker");

  note(
    "session-picker",
    `会话讨论可用：${discussion.map((p) => p.name).join(", ") || "（无）"}；任务 Worker：${workers.map((p) => p.name).join(", ") || "（无）"}`,
  );

  for (const profile of profiles) {
    const provider = byId[profile.providerId];
    if (provider === undefined) {
      fail(`bind-${profile.name}`, `Provider ${profile.providerId} 不存在`);
      continue;
    }
    const keyInjected =
      provider.type !== "cli_login" &&
      (profile.runtime === "codex" ||
        profile.runtime === "claude-code" ||
        profile.runtime === "gemini-cli" ||
        profile.runtime === "aider" ||
        profile.runtime === "qwen-code" ||
        profile.runtime === "iflow" ||
        profile.runtime === "grok-build");
    const baseUrlInjected =
      Boolean(provider.baseUrl) &&
      (profile.runtime === "codex" ||
        profile.runtime === "aider" ||
        profile.runtime === "qwen-code" ||
        profile.runtime === "iflow");
    const baseUrlDropped =
      Boolean(provider.baseUrl) && !baseUrlInjected && provider.type !== "cli_login";
    const nameSaysPlanner = /规划|plan/i.test(profile.name);
    const roleMismatch = nameSaysPlanner && profile.defaultRole !== "planner";
    const workerNoWrite =
      profile.defaultRole === "worker" && (profile.permissionPreset.writePaths?.length ?? 0) === 0;

    if (roleMismatch) {
      note(
        `name-vs-role-${profile.name}`,
        `名称像规划者，但 defaultRole=${profile.defaultRole} → 不进会话讨论下拉`,
      );
    }
    if (workerNoWrite) {
      note(
        `worker-nowrite-${profile.name}`,
        "Worker 可写范围为空白。任务合同再交也是空集，执行者落不了文件。",
      );
    }
    if (baseUrlDropped) {
      note(
        `baseurl-dropped-${profile.name}`,
        `${provider.type} + ${profile.runtime}：Provider.baseUrl 不会注入运行时（claude-code 无 ANTHROPIC_BASE_URL 通道）`,
      );
    }
    if (keyInjected && provider.type === "openai_compatible" && profile.runtime === "claude-code") {
      note(
        `key-as-anthropic-${profile.name}`,
        "openai_compatible 密钥会当成 ANTHROPIC_API_KEY 注入；中转 baseUrl 丢失。能聊通多半是本机 claude login，不是这张中转卡。",
      );
    }
    if (provider.type === "openai_compatible" && profile.runtime === "codex" && provider.baseUrl) {
      pass(
        `codex-api-pair-${profile.name}`,
        "codex + openai_compatible 是设计内配对（会下发 OPENAI_API_KEY + OPENAI_BASE_URL / -c 路由）",
      );
    }
  }

  const unusedProviders = providers.filter((p) => !profiles.some((pr) => pr.providerId === p.id));
  const unusedRoles = roles.filter((r) => !profiles.some((pr) => pr.defaultRole === r.id));
  if (unusedProviders.length > 0) {
    note("unused-providers", unusedProviders.map((p) => `${p.name}(${p.type})`).join(", "));
  }
  if (unusedRoles.length > 0) {
    note("unused-roles", unusedRoles.map((r) => r.name).join(", "));
  }

  // HTTP 真探测（只用已存 apiKeyRef，不打印密钥）
  for (const provider of providers) {
    if (provider.type !== "openai_compatible" && provider.type !== "anthropic") continue;
    try {
      const result = await invoke("providers:test-connection", {
        provider: {
          type: provider.type,
          ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
          ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}),
        },
        ...(provider.apiKeyRef ? { apiKeyRef: provider.apiKeyRef } : {}),
        ...(provider.defaultModel ? { model: provider.defaultModel } : {}),
        ...(provider.models?.[0]?.id && !provider.defaultModel
          ? { model: provider.models[0].id }
          : {}),
      });
      if (result.ok) {
        pass(`probe-${provider.name}`, `HTTP 通（${result.latencyMs} ms）`);
      } else {
        fail(
          `probe-${provider.name}`,
          `${result.stage ?? "fail"}：${String(result.rawError ?? "").slice(0, 180)}`,
        );
      }
    } catch (error) {
      fail(`probe-${provider.name}`, String(error.message ?? error).slice(0, 220));
    }
  }

  // 设置页列表是否与落盘一致
  await page.evaluate(() => {
    window.location.hash = "#/settings";
  });
  await page.waitForTimeout(400);
  for (const p of providers) {
    const n = await page.getByText(p.name, { exact: true }).count();
    if (n > 0) pass(`ui-provider-${p.name}`, "设置页看得到");
    else fail(`ui-provider-${p.name}`, "设置页看不到这个 Provider");
  }
  for (const p of profiles) {
    const n = await page.getByText(p.name, { exact: true }).count();
    if (n > 0) pass(`ui-profile-${p.name}`, "设置页看得到");
    else fail(`ui-profile-${p.name}`, "设置页看不到这个 Profile");
  }

  // 点开会话：讨论区是否只有 planner
  if (projects[0]) {
    await page.evaluate((id) => {
      window.localStorage.setItem(
        "ffpane.ui-state",
        JSON.stringify({ state: { activeProjectId: id }, version: 1 }),
      );
    }, projects[0].id);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(() => {
      window.location.hash = "#/session";
    });
    await page.waitForTimeout(600);
    const goSettings = await page.getByRole("button", { name: "Go to Settings" }).count();
    const composer = await page.getByLabel("Message composer").count();
    if (discussion.length === 0 && goSettings > 0) {
      pass("session-no-planner", "无 planner Profile 时会话页引导去设置（与点击一致）");
    } else if (discussion.length > 0 && composer > 0 && goSettings === 0) {
      pass(
        "session-has-planner",
        `有讨论 Profile（${discussion.map((p) => p.name).join(", ")}），输入框可用`,
      );
    } else {
      fail(
        "session-state",
        `discussion=${discussion.length} composer=${composer} goSettings=${goSettings}`,
      );
    }
    for (const w of workers) {
      const shown = await page.getByText(w.name, { exact: true }).count();
      if (shown === 0) {
        pass(`session-hides-${w.name}`, "Worker Profile 不出现在会话页（只能走任务派发）");
      } else {
        note(`session-hides-${w.name}`, "页面上出现了该名字，可能来自别处文案");
      }
    }
  }
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
}

const failed = results.filter((r) => !r.ok);
const notes = results.filter((r) => r.note);
console.log(
  `\n真实配置核验：${results.filter((r) => r.ok && !r.note).length} 过 / ${failed.length} 失败 / ${notes.length} 备查 / 共 ${results.length}`,
);
if (failed.length > 0) process.exitCode = 1;
