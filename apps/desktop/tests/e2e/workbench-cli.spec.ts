/**
 * T10.4 / T10.4'：工作台 AI 窗口启动 / 续接 / 多行 prompt / 重启不自动开 E2E。
 * 假 CLI = npm 形态 .cmd → node + js（与直启解析一致），打印 JSON argv（不打印密钥值）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

function writeFakeCli(dir: string, name: "claude" | "codex", envKey: string): void {
  const bin = join(dir, "node_modules", name, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, `${name}.js`);
  writeFileSync(
    script,
    [
      "#!/usr/bin/env node",
      `const tag = ${JSON.stringify(name === "claude" ? "FAKE_CLAUDE" : "FAKE_CODEX")};`,
      "const argv = process.argv.slice(2);",
      "process.stdout.write(tag + '_ARGV_JSON=' + JSON.stringify(argv) + '\\n');",
      `const key = ${JSON.stringify(envKey)};`,
      "process.stdout.write(tag + '_ENV_' + key + '=' + (process.env[key] ? 'present' : 'absent') + '\\n');",
      "process.stdout.write(tag + '_ENV_FF_PANE_WINDOW_TOKEN=' + (process.env.FF_PANE_WINDOW_TOKEN ? 'present' : 'absent') + '\\n');",
      "process.exit(0);",
      "",
    ].join("\n"),
    "utf8",
  );
  // npm 全局垫片形态（供 resolveDirectCliTarget 解析）
  writeFileSync(
    join(dir, `${name}.cmd`),
    [
      "@ECHO off",
      "SETLOCAL",
      "CALL :find_dp0",
      `IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" ) ELSE ( SET "_prog=node" )`,
      `endLocal & "%_prog%"  "%dp0%\\node_modules\\${name}\\bin\\${name}.js" %*`,
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      "",
    ].join("\r\n"),
    "utf8",
  );
}

function seedFakeClaude(dir: string): void {
  writeFakeCli(dir, "claude", "ANTHROPIC_API_KEY");
}

function seedFakeCodex(dir: string): void {
  writeFakeCli(dir, "codex", "OPENAI_API_KEY");
}

async function createProject(
  app: LaunchedApp["app"],
  page: LaunchedApp["page"],
  dir: string,
  name: string,
): Promise<void> {
  await app.evaluate(async ({ dialog }, path) => {
    // biome-ignore lint/suspicious/noExplicitAny: E2E 打桩
    (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, dir);
  await gotoRoute(page, "/projects");
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("button", { name: /Choose directory/i }).click();
  await expect(page.locator("#create-project-path")).toHaveValue(dir);
  await page.locator("#create-project-name").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
}

async function requireWindowId(page: LaunchedApp["page"], index = 0): Promise<string> {
  const id = await page.getByTestId("workbench-window").nth(index).getAttribute("data-window-id");
  expect(id).toBeTruthy();
  if (id === null) {
    throw new Error("missing window id");
  }
  return id;
}

async function readReplayForWindow(page: LaunchedApp["page"], windowId: string): Promise<string> {
  return page.evaluate(async (wid) => {
    const host = document.querySelector(`[data-window-id="${wid}"]`);
    const id = host?.querySelector('[data-testid="terminal-id"]')?.textContent?.trim();
    if (id === undefined || id.length === 0) {
      return "";
    }
    // biome-ignore lint/suspicious/noExplicitAny: E2E
    const replay = await (window as any).ffpane.invoke("terminal:get-replay", { id });
    return typeof replay?.data === "string" ? replay.data : "";
  }, windowId);
}

function parseArgvJson(replay: string, tag: "FAKE_CLAUDE" | "FAKE_CODEX"): string[] {
  const line = replay.split(/\r?\n/).find((item) => item.includes(`${tag}_ARGV_JSON=`));
  expect(line).toBeTruthy();
  const json = line?.slice(line.indexOf("=") + 1) ?? "[]";
  return JSON.parse(json) as string[];
}

async function confirmAiWindow(
  page: LaunchedApp["page"],
  kind: "claude" | "codex",
  initialPrompt?: string,
  permission?: "read-only" | "edit" | "edit-exec" | "yolo",
): Promise<void> {
  await expect(page.getByTestId("workbench-new-window-dialog")).toBeVisible();
  await page.getByTestId(`workbench-new-kind-${kind}`).click();
  await expect(page.getByTestId("workbench-new-profile")).toBeVisible({ timeout: 10_000 });
  if (permission !== undefined) {
    await page.getByTestId(`workbench-new-permission-${permission}`).click();
    if (permission === "yolo") {
      await page.getByTestId("workbench-new-yolo-confirm").check();
    }
  }
  if (initialPrompt !== undefined) {
    await page.getByTestId("workbench-new-prompt").fill(initialPrompt);
    await page.getByTestId("workbench-new-prompt").evaluate((el, value) => {
      const node = el as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    }, initialPrompt);
  }
  await expect(page.getByTestId("workbench-new-confirm")).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId("workbench-new-confirm").click();
}

test("Claude 窗口启动参数正确，退出后可续接，重启不自动开", async () => {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-wbcli-"));
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-wbcli-proj-"));
  seedFakeClaude(fakeBinDir);
  seedFakeCodex(fakeBinDir);

  let launched = await launchApp({ pathPrepend: fakeBinDir, retainDataRoot: true });
  const dataRoot = launched.dataRoot;

  try {
    const { app, page } = launched;
    await createProject(app, page, projectDir, "E2E WB CLI");
    await page.getByRole("button", { name: /^E2E WB CLI/ }).click();

    await page.evaluate(async () => {
      const invoke = (channel: string, req?: unknown) =>
        // biome-ignore lint/suspicious/noExplicitAny: E2E
        (window as any).ffpane.invoke(channel, req);
      const provider = await invoke("providers:create", {
        draft: {
          name: "Local Claude",
          templateId: "local-login",
          models: [{ id: "sonnet", label: "Sonnet", kind: "chat" }],
          defaultModelId: "sonnet",
          enabled: true,
        },
      });
      await invoke("profiles:create", {
        draft: {
          name: "Claude WB",
          runtime: "claude-code",
          providerId: provider.id,
          defaultRole: "worker",
          permissionPreset: {
            readPaths: ["**"],
            writePaths: ["**"],
            shell: "allowed",
            network: false,
            dangerousOpsRequireApproval: true,
          },
          connectionMode: "local_cli",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      });
    });

    const multilinePrompt = 'line1\nline2 & echo PWNED | %PATH% !x! "quoted"';

    await gotoRoute(page, "/workbench");
    await page.getByTestId("workbench-new-tab").click();
    await confirmAiWindow(page, "claude", multilinePrompt);

    const windowId = await requireWindowId(page, 0);
    await expect(page.locator(`[data-window-id="${windowId}"]`)).toHaveAttribute(
      "data-window-kind",
      "claude",
    );
    await expect
      .poll(async () => readReplayForWindow(page, windowId), { timeout: 20_000 })
      .toContain("FAKE_CLAUDE_ARGV_JSON=");
    const text = await readReplayForWindow(page, windowId);
    const argv = parseArgvJson(text, "FAKE_CLAUDE");
    expect(argv).toContain("--session-id");
    expect(argv).toContain("--model");
    expect(argv).toContain("sonnet");
    expect(argv).toContain("--effort");
    expect(argv).toContain("medium");
    expect(argv).toContain(multilinePrompt);
    expect(text).toMatch(/FAKE_CLAUDE_ENV_ANTHROPIC_API_KEY=absent/);

    await expect(page.getByTestId("terminal-cli-stopped")).toBeVisible({ timeout: 15_000 });
    const sessionIdx = argv.indexOf("--session-id");
    const sessionId = argv[sessionIdx + 1];
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/i);

    await page.getByTestId("cli-resume").click({ force: true });
    await expect
      .poll(
        async () => {
          const replay = await readReplayForWindow(page, windowId);
          return replay.includes("--resume") ? replay : "";
        },
        { timeout: 20_000 },
      )
      .toContain("--resume");
    const afterResume = parseArgvJson(await readReplayForWindow(page, windowId), "FAKE_CLAUDE");
    expect(afterResume).toContain("--resume");
    expect(afterResume).toContain(sessionId);

    await page.waitForTimeout(600);
    await launched.cleanup();
    launched = await launchApp({ dataRoot, pathPrepend: fakeBinDir, retainDataRoot: false });
    await launched.page.getByRole("button", { name: /^E2E WB CLI/ }).click();
    await gotoRoute(launched.page, "/workbench");
    await expect(launched.page.getByTestId("workbench-window").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(launched.page.getByTestId("terminal-cli-stopped")).toBeVisible({
      timeout: 10_000,
    });
    const restartedId = await requireWindowId(launched.page, 0);
    await expect
      .poll(async () => readReplayForWindow(launched.page, restartedId), { timeout: 5_000 })
      .toBe("");
  } finally {
    await launched.cleanup();
    rmSync(fakeBinDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("Codex 窗口至少能启动并打印 argv", async () => {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-wbcodex-"));
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-wbcodex-proj-"));
  seedFakeClaude(fakeBinDir);
  seedFakeCodex(fakeBinDir);
  const launched = await launchApp({ pathPrepend: fakeBinDir });
  try {
    const { app, page } = launched;
    await createProject(app, page, projectDir, "E2E WB Codex");
    await page.getByRole("button", { name: /^E2E WB Codex/ }).click();
    await page.evaluate(async () => {
      const invoke = (channel: string, req?: unknown) =>
        // biome-ignore lint/suspicious/noExplicitAny: E2E
        (window as any).ffpane.invoke(channel, req);
      const provider = await invoke("providers:create", {
        draft: {
          name: "Local Codex",
          templateId: "local-login",
          models: [{ id: "gpt-5", label: "GPT", kind: "chat" }],
          defaultModelId: "gpt-5",
          enabled: true,
        },
      });
      await invoke("profiles:create", {
        draft: {
          name: "Codex WB",
          runtime: "codex",
          providerId: provider.id,
          defaultRole: "worker",
          permissionPreset: {
            readPaths: ["**"],
            writePaths: ["**"],
            shell: "allowed",
            network: false,
            dangerousOpsRequireApproval: true,
          },
          connectionMode: "local_cli",
          model: "gpt-5",
        },
      });
    });

    await gotoRoute(page, "/workbench");
    await page.getByTestId("workbench-new-tab").click();
    await confirmAiWindow(page, "codex");
    const windowId = await requireWindowId(page, 0);
    await expect(page.locator(`[data-window-id="${windowId}"]`)).toHaveAttribute(
      "data-window-kind",
      "codex",
    );
    await expect
      .poll(async () => readReplayForWindow(page, windowId), { timeout: 20_000 })
      .toContain("FAKE_CODEX_ARGV_JSON=");
    const text = await readReplayForWindow(page, windowId);
    const argv = parseArgvJson(text, "FAKE_CODEX");
    expect(argv).toContain("-C");
    expect(argv).toContain("-m");
    expect(argv).toContain("gpt-5");
    expect(text).toMatch(/FAKE_CODEX_ENV_OPENAI_API_KEY=absent/);
  } finally {
    await launched.cleanup();
    rmSync(fakeBinDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("Codex 预置假 rollout 后认领成功，续接 argv 为 resume <id>", async () => {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-wbclaim-"));
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-wbclaim-proj-"));
  const codexHome = mkdtempSync(join(tmpdir(), "ffpane-e2e-wbclaim-codex-"));
  seedFakeClaude(fakeBinDir);
  seedFakeCodex(fakeBinDir);

  const claimedId = "e2e-codex-claim-sess-001";
  const launched = await launchApp({ pathPrepend: fakeBinDir, codexHome });
  try {
    expect(launched.codexHome).toBe(codexHome);
    expect(launched.codexHome.toLowerCase()).not.toMatch(/[/\\]\.codex$/);

    const { app, page } = launched;
    await createProject(app, page, projectDir, "E2E WB Claim");
    await page.getByRole("button", { name: /^E2E WB Claim/ }).click();
    await page.evaluate(async () => {
      const invoke = (channel: string, req?: unknown) =>
        // biome-ignore lint/suspicious/noExplicitAny: E2E
        (window as any).ffpane.invoke(channel, req);
      const provider = await invoke("providers:create", {
        draft: {
          name: "Local Codex Claim",
          templateId: "local-login",
          models: [{ id: "gpt-5", label: "GPT", kind: "chat" }],
          defaultModelId: "gpt-5",
          enabled: true,
        },
      });
      await invoke("profiles:create", {
        draft: {
          name: "Codex Claim WB",
          runtime: "codex",
          providerId: provider.id,
          defaultRole: "worker",
          permissionPreset: {
            readPaths: ["**"],
            writePaths: ["**"],
            shell: "allowed",
            network: false,
            dangerousOpsRequireApproval: true,
          },
          connectionMode: "local_cli",
          model: "gpt-5",
        },
      });
    });

    // 紧挨启动写入假 rollout（本地日目录），保证 mtime/timestamp 落在认领窗口内
    const stampMs = Date.now();
    const local = new Date(stampMs);
    const day = [
      local.getFullYear().toString().padStart(4, "0"),
      (local.getMonth() + 1).toString().padStart(2, "0"),
      local.getDate().toString().padStart(2, "0"),
    ].join("/");
    const sessionDir = join(codexHome, "sessions", ...day.split("/"));
    mkdirSync(sessionDir, { recursive: true });
    const iso = new Date(stampMs).toISOString();
    writeFileSync(
      join(sessionDir, `rollout-${iso.replace(/[:.]/g, "-")}-${claimedId}.jsonl`),
      `${JSON.stringify({
        type: "session_meta",
        payload: { id: claimedId, cwd: projectDir, timestamp: iso },
      })}\n`,
      "utf8",
    );

    await gotoRoute(page, "/workbench");
    await page.getByTestId("workbench-new-tab").click();
    await expect(page.getByTestId("workbench-new-window-dialog")).toBeVisible();
    await page.getByTestId("workbench-new-kind-codex").click();
    await expect(page.getByTestId("workbench-new-profile")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("workbench-new-confirm")).toBeEnabled({ timeout: 15_000 });

    const claimedWait = page.evaluate(() => {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("session-claimed timeout")), 15_000);
        // biome-ignore lint/suspicious/noExplicitAny: E2E
        const unsub = (window as any).ffpane.subscribe(
          "workbench:session-claimed",
          (payload: { windowId: string; nativeSessionId: string }) => {
            clearTimeout(timer);
            unsub();
            resolve(payload.nativeSessionId);
          },
        );
      });
    });
    await page.getByTestId("workbench-new-confirm").click();
    const windowId = await requireWindowId(page, 0);
    await expect(claimedWait).resolves.toBe(claimedId);

    // 落盘防抖后再确认布局侧也有 id（可选加固）
    await page.waitForTimeout(600);
    await expect
      .poll(
        async () => {
          return page.evaluate(async (wid) => {
            // biome-ignore lint/suspicious/noExplicitAny: E2E
            const layouts = await (window as any).ffpane.invoke("workbench:get-layouts");
            for (const layout of Object.values(
              layouts as Record<string, { windows?: Record<string, { nativeSessionId?: string }> }>,
            )) {
              const native = layout.windows?.[wid]?.nativeSessionId;
              if (typeof native === "string" && native.length > 0) {
                return native;
              }
            }
            return "";
          }, windowId);
        },
        { timeout: 10_000 },
      )
      .toBe(claimedId);

    await expect(page.getByTestId("terminal-cli-stopped")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("cli-resume").click({ force: true });
    await expect
      .poll(
        async () => {
          const replay = await readReplayForWindow(page, windowId);
          return replay.includes("FAKE_CODEX_ARGV_JSON=") && replay.includes("resume")
            ? replay
            : "";
        },
        { timeout: 20_000 },
      )
      .not.toBe("");
    const argv = parseArgvJson(await readReplayForWindow(page, windowId), "FAKE_CODEX");
    expect(argv[0]).toBe("resume");
    expect(argv).toContain(claimedId);
    expect(argv).not.toContain("--last");
  } finally {
    await launched.cleanup();
    rmSync(fakeBinDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("T10.5：只读 Claude 权限参数 + 令牌 env 存在 + 改 yolo 重启", async () => {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-wbperm-"));
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-wbperm-proj-"));
  seedFakeClaude(fakeBinDir);
  seedFakeCodex(fakeBinDir);

  const launched = await launchApp({ pathPrepend: fakeBinDir });
  try {
    const { app, page } = launched;
    await createProject(app, page, projectDir, "E2E WB Perm");
    await page.getByRole("button", { name: /^E2E WB Perm/ }).click();

    await page.evaluate(async (dir: string) => {
      const invoke = (channel: string, req?: unknown) =>
        // biome-ignore lint/suspicious/noExplicitAny: E2E
        (window as any).ffpane.invoke(channel, req);
      const provider = await invoke("providers:create", {
        draft: {
          name: "Local Claude",
          templateId: "local-login",
          models: [{ id: "sonnet", label: "Sonnet", kind: "chat" }],
          defaultModelId: "sonnet",
          enabled: true,
        },
      });
      await invoke("profiles:create", {
        draft: {
          name: "Claude Perm",
          runtime: "claude-code",
          providerId: provider.id,
          defaultRole: "worker",
          permissionPreset: {
            readPaths: ["**"],
            writePaths: ["**"],
            shell: "allowed",
            network: false,
            dangerousOpsRequireApproval: true,
          },
          connectionMode: "local_cli",
          model: "sonnet",
        },
      });
      await invoke("projects:update-settings", {
        projectRoot: dir,
        patch: { knowledgeToolEnabled: true },
      });
    }, projectDir);

    await gotoRoute(page, "/workbench");
    await page.getByTestId("workbench-new-tab").click();
    await confirmAiWindow(page, "claude", undefined, "read-only");

    const windowId = await requireWindowId(page, 0);
    await expect(page.getByTestId("workbench-permission-badge")).toHaveAttribute(
      "data-permission",
      "read-only",
    );
    await expect(page.getByTestId("workbench-opened-by")).toContainText(/you|你/i);

    await expect
      .poll(async () => readReplayForWindow(page, windowId), { timeout: 20_000 })
      .toContain("FAKE_CLAUDE_ARGV_JSON=");
    const text = await readReplayForWindow(page, windowId);
    const argv = parseArgvJson(text, "FAKE_CLAUDE");
    expect(argv).toContain("--permission-mode");
    expect(argv).toContain("plan");
    expect(argv).toContain("--disallowedTools");
    expect(argv).toContain("Bash");
    expect(text).toMatch(/FAKE_CLAUDE_ENV_FF_PANE_WINDOW_TOKEN=present/);
    expect(JSON.stringify(argv)).not.toMatch(/[a-f0-9]{64}/i);

    // 挂了知识库 MCP 时：临时 --mcp-config 不得含令牌明文（仅 ${FF_PANE_WINDOW_TOKEN}）
    const mcpIdx = argv.indexOf("--mcp-config");
    expect(mcpIdx).toBeGreaterThanOrEqual(0);
    const mcpPath = argv[mcpIdx + 1];
    expect(typeof mcpPath).toBe("string");
    if (typeof mcpPath === "string") {
      const { readFileSync } = await import("node:fs");
      const mcpText = readFileSync(mcpPath, "utf8");
      expect(mcpText).toContain("$" + "{FF_PANE_WINDOW_TOKEN}");
      expect(mcpText).not.toMatch(/"FF_PANE_WINDOW_TOKEN"\s*:\s*"[a-f0-9]{64}"/i);
    }

    await expect(page.getByTestId("terminal-cli-stopped")).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("workbench-permission-badge").click();
    await expect(page.getByTestId("workbench-permission-editor")).toBeVisible();
    await page.getByTestId("workbench-permission-select").selectOption("yolo");
    await page.getByTestId("workbench-permission-yolo-confirm").check();
    await page.getByTestId("workbench-permission-apply").click();
    await expect(page.getByTestId("workbench-permission-badge")).toHaveAttribute(
      "data-permission",
      "yolo",
    );

    await page.getByTestId("cli-restart-fresh").click({ force: true });
    await expect
      .poll(
        async () => {
          const replay = await readReplayForWindow(page, windowId);
          return replay.includes("--dangerously-skip-permissions") ? replay : "";
        },
        { timeout: 20_000 },
      )
      .toContain("--dangerously-skip-permissions");
    const after = parseArgvJson(await readReplayForWindow(page, windowId), "FAKE_CLAUDE");
    expect(after).toContain("--dangerously-skip-permissions");
    expect(after).not.toContain("plan");
  } finally {
    await launched.cleanup();
    rmSync(fakeBinDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});
