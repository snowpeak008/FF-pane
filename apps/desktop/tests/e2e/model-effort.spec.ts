/**
 * T10.12b：假 CLI。管理者改工作者强度后，空闲时自动续接；
 * 改管理者自己则先出现确认，点确认后才续接。
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fake-workbench-cli.js");

function seedFakeClaude(dir: string): void {
  const bin = join(dir, "node_modules", "claude", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude.js"), readFileSync(fixture));
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

async function openManagerWindow(page: LaunchedApp["page"], projectName: string): Promise<string> {
  await page.getByRole("button", { name: new RegExp(`^${projectName}`) }).click();
  await gotoRoute(page, "/workbench");
  await page.getByTestId("workbench-new-tab").click();
  await expect(page.getByTestId("workbench-new-window-dialog")).toBeVisible();
  await page.getByTestId("workbench-new-kind-claude").click();
  await expect(page.getByTestId("workbench-new-confirm")).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId("workbench-new-role-manager").click();
  await page.getByTestId("workbench-new-confirm").click();
  const manager = page.getByTestId("workbench-window").first();
  await expect(manager).toBeVisible();
  const managerId = await manager.getAttribute("data-window-id");
  expect(managerId).toBeTruthy();
  return managerId ?? "";
}

test("管理者改工作者强度，空闲后自动续接并带上新强度", async () => {
  test.setTimeout(120_000);
  const fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-effort-bin-"));
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-effort-proj-"));
  seedFakeClaude(fakeBinDir);
  const launched = await launchApp({
    pathPrepend: fakeBinDir,
    extraEnv: { FFPANE_WB_SCRIPT: "effort-worker" },
  });
  try {
    const { app, page } = launched;
    await createProject(app, page, projectDir, "E2E Effort");
    const managerId = await openManagerWindow(page, "E2E Effort");
    await expect
      .poll(async () => readReplayForWindow(page, managerId), { timeout: 90_000 })
      .toContain("已排队，空闲时自动续接");

    const child = page.getByTestId("workbench-window").filter({ hasText: "强度工" });
    await expect(child).toBeVisible();
    const childId = await child.getAttribute("data-window-id");
    expect(childId).toBeTruthy();
    await expect
      .poll(async () => readReplayForWindow(page, childId ?? ""), { timeout: 60_000 })
      .toContain("FFPANE_RESUMED=1");
    const replay = await readReplayForWindow(page, childId ?? "");
    expect(replay).toContain("--effort");
    expect(replay).toContain("high");
    await expect(child.getByTestId("workbench-window-route")).toContainText("high");
  } finally {
    await launched.cleanup();
  }
});

test("改管理者自己时先确认，点确认后才续接", async () => {
  test.setTimeout(120_000);
  const fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-effort-self-bin-"));
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-effort-self-proj-"));
  seedFakeClaude(fakeBinDir);
  const launched = await launchApp({
    pathPrepend: fakeBinDir,
    extraEnv: { FFPANE_WB_SCRIPT: "effort-self" },
  });
  try {
    const { app, page } = launched;
    await createProject(app, page, projectDir, "E2E Self");
    const managerId = await openManagerWindow(page, "E2E Self");
    await expect(page.getByRole("dialog", { name: "Start this window?" })).toBeVisible({
      timeout: 90_000,
    });
    const before = await readReplayForWindow(page, managerId);
    expect(before).not.toContain("FFPANE_RESUMED=1");
    await page
      .getByRole("dialog", { name: "Start this window?" })
      .getByRole("button", { name: "Start" })
      .click();
    await expect
      .poll(async () => readReplayForWindow(page, managerId), { timeout: 60_000 })
      .toContain("FFPANE_RESUMED=1");
    const replay = await readReplayForWindow(page, managerId);
    expect(replay).toContain("--effort");
    expect(replay).toContain("low");
    await expect(page.getByTestId("workbench-window-route")).toContainText("low");
  } finally {
    await launched.cleanup();
  }
});
