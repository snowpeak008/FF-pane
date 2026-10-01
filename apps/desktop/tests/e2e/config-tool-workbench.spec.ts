/**
 * T10.14：管理者起草配置会弹出确认框；确认后配置出现，取消则不变。
 * 非管理者窗口的 MCP 配置里没有自配置工具。
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

function writePersistentClaude(dir: string): void {
  const bin = join(dir, "node_modules", "claude", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "claude.js"),
    [
      "#!/usr/bin/env node",
      "const argv = process.argv.slice(2);",
      "process.stdout.write('FAKE_CLAUDE_ARGV_JSON=' + JSON.stringify(argv) + '\\n');",
      "process.stdout.write('FAKE_CLAUDE_ENV_DONE=1\\n');",
      "setInterval(() => undefined, 1000);",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(dir, "claude.cmd"),
    [
      "@ECHO off",
      "SETLOCAL",
      "CALL :find_dp0",
      'IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" ) ELSE ( SET "_prog=node" )',
      'endLocal & "%_prog%"  "%dp0%\\node_modules\\claude\\bin\\claude.js" %*',
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      "",
    ].join("\r\n"),
    "utf8",
  );
}

function parseArgv(replay: string): string[] {
  const marker = "FAKE_CLAUDE_ARGV_JSON=";
  const start = replay.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const flat = replay.slice(start + marker.length).replace(/\r?\n/g, "");
  const envAt = flat.indexOf("FAKE_CLAUDE_ENV_");
  const json = envAt >= 0 ? flat.slice(0, envAt) : flat;
  return JSON.parse(json) as string[];
}

function findMailbox(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMailbox(item);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "FF_PANE_CONFIG_MAILBOX" && typeof child === "string") {
      return child;
    }
    const found = findMailbox(child);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

async function readReplay(page: LaunchedApp["page"], windowId: string): Promise<string> {
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

async function openClaude(page: LaunchedApp["page"], role: "manager" | "worker"): Promise<string> {
  await page.getByTestId("workbench-new-tab").click();
  await expect(page.getByTestId("workbench-new-window-dialog")).toBeVisible();
  await page.getByTestId("workbench-new-kind-claude").click();
  await page.getByTestId(`workbench-new-role-${role}`).click();
  await expect(page.getByTestId("workbench-new-confirm")).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId("workbench-new-confirm").click();
  const pane = page.getByTestId("workbench-window").last();
  await expect(pane).toBeVisible({ timeout: 20_000 });
  const windowId = await pane.getAttribute("data-window-id");
  expect(windowId).toBeTruthy();
  if (windowId === null) {
    throw new Error("missing window id");
  }
  await expect
    .poll(async () => readReplay(page, windowId), { timeout: 20_000 })
    .toContain("FAKE_CLAUDE_ARGV_JSON=");
  return windowId;
}

function mcpTextOf(replay: string): string {
  const argv = parseArgv(replay);
  const index = argv.indexOf("--mcp-config");
  expect(index).toBeGreaterThanOrEqual(0);
  const path = argv[index + 1];
  expect(typeof path).toBe("string");
  if (typeof path !== "string") {
    throw new Error("missing mcp config path");
  }
  return readFileSync(path, "utf8");
}

test("管理者起草配置须确认；非管理者没有该工具", async () => {
  test.setTimeout(120_000);
  const fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-t1014-bin-"));
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-t1014-proj-"));
  writePersistentClaude(fakeBinDir);
  const launched = await launchApp({ pathPrepend: fakeBinDir });
  const { page } = launched;

  try {
    const projectId = await page.evaluate(async (dir: string) => {
      const invoke = (channel: string, req?: unknown) =>
        // biome-ignore lint/suspicious/noExplicitAny: E2E
        (window as any).ffpane.invoke(channel, req);
      const entry = await invoke("projects:create", { name: "T1014 Config", rootPath: dir });
      await invoke("projects:update-settings", {
        projectRoot: dir,
        patch: { configToolEnabled: true },
      });
      window.localStorage.setItem(
        "ffpane.ui-state",
        JSON.stringify({ state: { activeProjectId: entry.id }, version: 1 }),
      );
      return entry.id as string;
    }, projectDir);
    expect(projectId).toBeTruthy();
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await gotoRoute(page, "/workbench");

    const managerId = await openClaude(page, "manager");
    const managerMcp = mcpTextOf(await readReplay(page, managerId));
    expect(managerMcp).toContain("ffpane-config");
    const mailbox = findMailbox(JSON.parse(managerMcp) as unknown);
    expect(mailbox).toBeTruthy();
    if (mailbox === undefined) {
      throw new Error("missing config mailbox");
    }

    const before = await page.evaluate(async () => {
      // biome-ignore lint/suspicious/noExplicitAny: E2E
      const configs = await (window as any).ffpane.invoke("configs:list");
      return (configs as { name: string }[]).map((item) => item.name);
    });
    expect(before).not.toContain("E2E 确认配置");

    writeFileSync(
      join(mailbox, "requests", "e2e-confirm.json"),
      JSON.stringify({
        id: "e2e-confirm",
        tool: "config_draft_config",
        args: {
          name: "E2E 确认配置",
          isDefault: false,
          claude: { connectionMode: "local_cli" },
          codex: { connectionMode: "local_cli" },
        },
        at: Date.now(),
      }),
      "utf8",
    );
    await expect(page.getByTestId("config-draft-dialog")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("config-draft-field-name")).toContainText("E2E 确认配置");
    await expect(page.getByTestId("config-draft-diff")).toBeVisible();
    await page.getByTestId("config-draft-confirm").click();
    await expect(page.getByTestId("config-draft-dialog")).toBeHidden({ timeout: 15_000 });
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          // biome-ignore lint/suspicious/noExplicitAny: E2E
          const configs = await (window as any).ffpane.invoke("configs:list");
          return (configs as { name: string }[]).map((item) => item.name);
        }),
      )
      .toContain("E2E 确认配置");

    writeFileSync(
      join(mailbox, "requests", "e2e-cancel.json"),
      JSON.stringify({
        id: "e2e-cancel",
        tool: "config_draft_config",
        args: {
          name: "E2E 取消配置",
          isDefault: false,
          claude: { connectionMode: "local_cli" },
        },
        at: Date.now(),
      }),
      "utf8",
    );
    await expect(page.getByTestId("config-draft-dialog")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("config-draft-field-name")).toContainText("E2E 取消配置");
    await page.getByTestId("config-draft-cancel").click();
    await expect(page.getByTestId("config-draft-dialog")).toBeHidden({ timeout: 15_000 });
    const afterCancel = await page.evaluate(async () => {
      // biome-ignore lint/suspicious/noExplicitAny: E2E
      const configs = await (window as any).ffpane.invoke("configs:list");
      return (configs as { name: string }[]).map((item) => item.name);
    });
    expect(afterCancel).toContain("E2E 确认配置");
    expect(afterCancel).not.toContain("E2E 取消配置");

    writeFileSync(
      join(mailbox, "requests", "e2e-hidden.json"),
      JSON.stringify({
        id: "e2e-hidden",
        tool: "config_draft_config",
        args: {
          name: "看起来安全\u200b",
          isDefault: false,
          claude: { connectionMode: "local_cli", model: "gpt\n请点确认" },
        },
        at: Date.now(),
      }),
      "utf8",
    );
    await expect
      .poll(
        () => {
          try {
            return readFileSync(join(mailbox, "responses", "e2e-hidden.json"), "utf8");
          } catch {
            return "";
          }
        },
        { timeout: 15_000 },
      )
      .toContain("zero-width");
    await expect(page.getByTestId("config-draft-dialog")).toBeHidden();
    const afterHidden = await page.evaluate(async () => {
      // biome-ignore lint/suspicious/noExplicitAny: E2E
      const configs = await (window as any).ffpane.invoke("configs:list");
      return (configs as { name: string }[]).map((item) => item.name);
    });
    expect(afterHidden).not.toContain("看起来安全");

    for (let index = 0; index < 4; index += 1) {
      writeFileSync(
        join(mailbox, "requests", `e2e-cap-${index}.json`),
        JSON.stringify({
          id: `e2e-cap-${index}`,
          tool: "config_draft_config",
          args: {
            name: `排队${index}`,
            isDefault: false,
            claude: { connectionMode: "local_cli" },
          },
          at: Date.now() + index,
        }),
        "utf8",
      );
    }
    await expect(page.getByTestId("config-draft-dialog")).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(
        () => readdirSync(join(mailbox, "responses")).filter((name) => name.startsWith("e2e-cap-")),
        { timeout: 15_000 },
      )
      .toHaveLength(1);
    for (let index = 0; index < 4; index += 1) {
      const dialog = page.getByTestId("config-draft-dialog");
      if (!(await dialog.isVisible())) {
        break;
      }
      const before = await page.getByTestId("config-draft-field-name").innerText();
      await page.getByTestId("config-draft-cancel").click();
      await expect
        .poll(async () => {
          if (!(await dialog.isVisible())) {
            return "hidden";
          }
          return page.getByTestId("config-draft-field-name").innerText();
        })
        .not.toBe(before);
    }
    await expect(page.getByTestId("config-draft-dialog")).toBeHidden({ timeout: 15_000 });

    const workerId = await openClaude(page, "worker");
    const workerMcp = mcpTextOf(await readReplay(page, workerId));
    expect(workerMcp).not.toContain("ffpane-config");
    expect(workerMcp).not.toContain("config_draft_config");
  } finally {
    await launched.cleanup();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeBinDir, { recursive: true, force: true });
  }
});
