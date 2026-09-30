/**
 * T10.7a：假 CLI 走 Claude MCP 配置，管理者开窗口、执行者汇报、越权被拒。
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

test("管理者开窗口，执行者汇报，越权被拒，记录落盘", async () => {
  test.setTimeout(120_000);
  const fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-mcp-"));
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-mcp-proj-"));
  seedFakeClaude(fakeBinDir);
  const launched = await launchApp({ pathPrepend: fakeBinDir });
  try {
    const { app, page } = launched;
    await createProject(app, page, projectDir, "E2E MCP");
    await page.getByRole("button", { name: /^E2E MCP/ }).click();
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
    await gotoRoute(page, "/workbench");
    await page.getByTestId("workbench-new-tab").click();
    await expect(page.getByTestId("workbench-new-window-dialog")).toBeVisible();
    await page.getByTestId("workbench-new-kind-claude").click();
    await expect(page.getByTestId("workbench-new-profile")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("workbench-new-confirm")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("workbench-new-confirm").click();

    const manager = page.getByTestId("workbench-window").first();
    await expect(manager).toBeVisible();
    const managerId = await manager.getAttribute("data-window-id");
    expect(managerId).toBeTruthy();
    await expect
      .poll(
        async () => {
          const text = await readReplayForWindow(page, managerId ?? "");
          return text.includes("FFPANE_MCP_DONE=1") && text.includes("[新消息]") ? text : "";
        },
        { timeout: 90_000 },
      )
      .toContain("[新消息] 来自");
    const managerReplay = await readReplayForWindow(page, managerId ?? "");
    expect(managerReplay).toContain("汇报:done");
    expect(managerReplay).toContain("前端完成");

    const child = page.getByTestId("workbench-window").filter({ hasText: "前端A" });
    await expect(child).toBeVisible();
    await expect(child).toContainText(/Opened by|由 /);
    await expect(child.locator("[data-permission]")).toHaveAttribute("data-permission", "edit");
    await expect(child.locator("[data-role]")).toHaveAttribute("data-role", "worker");
    await expect(child.locator("[data-report-status]")).toHaveAttribute(
      "data-report-status",
      "done",
      {
        timeout: 15_000,
      },
    );

    const childId = await child.getAttribute("data-window-id");
    await expect
      .poll(async () => readReplayForWindow(page, childId ?? ""), { timeout: 30_000 })
      .toContain("FFPANE_MCP_WORKER_OPEN=denied");
    const childReplay = await readReplayForWindow(page, childId ?? "");
    expect(childReplay).toContain("FFPANE_MCP_WORKER_SEND=denied");
    expect(childReplay).toContain("FFPANE_MCP_WORKER_REPORT=ok");

    const threadDir = join(projectDir, ".ffpane", "threads");
    const names = readdirSync(threadDir);
    const index = readFileSync(join(threadDir, "index.jsonl"), "utf8");
    const lines = index
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { kind: string; status?: string; text: string });
    expect(lines.some((line) => line.kind === "message" && line.text.includes("开始吧"))).toBe(
      true,
    );
    expect(lines.some((line) => line.kind === "report" && line.status === "done")).toBe(true);
    const mdName = names.find((name) => name.endsWith(".md"));
    expect(mdName).toBeTruthy();
    const md = readFileSync(join(threadDir, mdName ?? ""), "utf8");
    expect(md).toContain("前端A");
    expect(md).toContain("汇报:done");
    expect(md).toContain("消息");
  } finally {
    await launched.cleanup();
  }
});
