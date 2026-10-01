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

async function readReplayForWindowId(page: LaunchedApp["page"], windowId: string): Promise<string> {
  return page.evaluate(async (wid) => {
    // biome-ignore lint/suspicious/noExplicitAny: E2E
    const list = await (window as any).ffpane.invoke("terminal:list");
    const rows = Array.isArray(list) ? list : [];
    const match =
      rows.find((row) => row?.metadata?.windowId === wid && row.exited !== true) ??
      rows.find((row) => row?.metadata?.windowId === wid);
    const id = match?.id;
    if (typeof id !== "string" || id.length === 0) {
      return "";
    }
    // biome-ignore lint/suspicious/noExplicitAny: E2E
    const replay = await (window as any).ffpane.invoke("terminal:get-replay", { id });
    return typeof replay?.data === "string" ? replay.data : "";
  }, windowId);
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

async function seedClaudeProfile(page: LaunchedApp["page"]): Promise<void> {
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
}

test("管理者读取并关闭子窗口，再打开任务页", async () => {
  test.setTimeout(120_000);
  const fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-mcp-close-"));
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-mcp-close-proj-"));
  seedFakeClaude(fakeBinDir);
  const launched = await launchApp({
    pathPrepend: fakeBinDir,
    extraEnv: { FFPANE_WB_SCRIPT: "close" },
  });
  try {
    const { app, page } = launched;
    await createProject(app, page, projectDir, "E2E Close");
    await page.getByRole("button", { name: /^E2E Close/ }).click();
    await seedClaudeProfile(page);
    await gotoRoute(page, "/workbench");
    await page.getByTestId("workbench-new-tab").click();
    await expect(page.getByTestId("workbench-new-window-dialog")).toBeVisible();
    await page.getByTestId("workbench-new-kind-claude").click();
    await expect(page.getByTestId("workbench-new-profile")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("workbench-new-confirm")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("workbench-new-confirm").click();

    const manager = page.getByTestId("workbench-window").first();
    const managerId = await manager.getAttribute("data-window-id");
    expect(managerId).toBeTruthy();
    await expect
      .poll(async () => readReplayForWindowId(page, managerId ?? ""), { timeout: 90_000 })
      .toContain("FFPANE_MCP_PANEL=ok");
    const replay = await readReplayForWindowId(page, managerId ?? "");
    expect(replay).toContain("FFPANE_MCP_READ=yes");
    expect(replay).toContain("FFPANE_MCP_CLOSE=ok");
    await expect(page).toHaveURL(/#\/workbench/);
    await expect(page.getByTestId("workbench-drawer")).toBeVisible();
    await expect(page.getByTestId("workbench-drawer-tab-tasks")).toHaveAttribute(
      "data-state",
      "active",
    );
    await expect(page.getByText(/Opened from /)).toBeVisible();
    await expect(page.getByText("前端关")).toHaveCount(0);
    await expect(page.getByTestId("workbench-window")).toHaveCount(1);
  } finally {
    await launched.cleanup();
  }
});

test("重启后子窗口仍被封顶，续接管理者可以再开窗口", async () => {
  test.setTimeout(120_000);
  const fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-mcp-restart-"));
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-mcp-restart-proj-"));
  seedFakeClaude(fakeBinDir);
  let launched = await launchApp({
    pathPrepend: fakeBinDir,
    retainDataRoot: true,
    extraEnv: { FFPANE_WB_SCRIPT: "restart" },
  });
  const dataRoot = launched.dataRoot;
  try {
    const { app, page } = launched;
    await createProject(app, page, projectDir, "E2E Restart");
    await page.getByRole("button", { name: /^E2E Restart/ }).click();
    await seedClaudeProfile(page);
    await gotoRoute(page, "/workbench");
    await page.getByTestId("workbench-new-tab").click();
    await expect(page.getByTestId("workbench-new-window-dialog")).toBeVisible();
    await page.getByTestId("workbench-new-kind-claude").click();
    await expect(page.getByTestId("workbench-new-profile")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("workbench-new-confirm")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("workbench-new-confirm").click();

    const manager = page.getByTestId("workbench-window").filter({ hasText: "Opened by you" });
    const managerId = await manager.getAttribute("data-window-id");
    expect(managerId).toBeTruthy();
    await expect
      .poll(async () => readReplayForWindow(page, managerId ?? ""), { timeout: 90_000 })
      .toContain("FFPANE_MCP_READY=1");
    const child = page.getByTestId("workbench-window").filter({ hasText: "前端A" });
    await expect(child).toBeVisible({ timeout: 30_000 });
    await expect(child.locator("[data-report-status]")).toHaveAttribute(
      "data-report-status",
      "done",
      { timeout: 30_000 },
    );
    await expect(manager.getByTestId("workbench-unread-badge")).toBeVisible({ timeout: 15_000 });

    await launched.cleanup();
    launched = await launchApp({
      dataRoot,
      pathPrepend: fakeBinDir,
      retainDataRoot: false,
      extraEnv: { FFPANE_WB_SCRIPT: "restart" },
    });
    const restarted = launched.page;
    await restarted.getByRole("button", { name: /^E2E Restart/ }).click();
    await gotoRoute(restarted, "/workbench");
    const restoredChild = restarted.getByTestId("workbench-window").filter({ hasText: "前端A" });
    await expect(restoredChild).toBeVisible();
    await expect(restoredChild.getByTestId("workbench-opened-by")).toContainText(/Opened by /);
    await expect(restoredChild.locator("[data-permission]")).toHaveAttribute(
      "data-permission",
      "edit",
    );
    await expect(restoredChild).toContainText("Restart required");
    await expect(restoredChild.locator("[data-report-status]")).toHaveAttribute(
      "data-report-status",
      "done",
    );
    const restoredManager = restarted
      .getByTestId("workbench-window")
      .filter({ hasText: "Opened by you" });
    await expect(restoredManager.getByTestId("workbench-unread-badge")).toBeVisible();
    await restoredManager.getByTestId("cli-resume").click({ force: true });
    const confirm = restarted.getByRole("dialog");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("Start this window?");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(restarted.getByText("前端B")).toHaveCount(0);
    await expect(restoredManager.getByTestId("cli-resume")).toBeVisible();
    await restoredManager.getByTestId("cli-resume").click({ force: true });
    await restarted.getByRole("dialog").getByRole("button", { name: "Start" }).click();
    await expect(restarted.getByText("前端B")).toBeVisible({ timeout: 90_000 });
  } finally {
    await launched.cleanup();
  }
});

test("隐藏面板：看板、计划预览、记录筛选，侧栏不再有旧页面", async () => {
  test.setTimeout(180_000);
  const fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-mcp-panel-"));
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-mcp-panel-proj-"));
  seedFakeClaude(fakeBinDir);
  const launched = await launchApp({
    pathPrepend: fakeBinDir,
    extraEnv: { FFPANE_WB_SCRIPT: "panel" },
  });
  try {
    const { app, page } = launched;
    await createProject(app, page, projectDir, "E2E Panel");
    await page.getByRole("button", { name: /^E2E Panel/ }).click();
    await seedClaudeProfile(page);
    await gotoRoute(page, "/workbench");
    await page.getByTestId("workbench-new-tab").click();
    await expect(page.getByTestId("workbench-new-window-dialog")).toBeVisible();
    await page.getByTestId("workbench-new-kind-claude").click();
    await expect(page.getByTestId("workbench-new-profile")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("workbench-new-confirm")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("workbench-new-confirm").click();

    const manager = page.getByTestId("workbench-window").first();
    const managerId = await manager.getAttribute("data-window-id");
    expect(managerId).toBeTruthy();
    await expect
      .poll(async () => readReplayForWindowId(page, managerId ?? ""), { timeout: 90_000 })
      .toContain("FFPANE_MCP_PANEL_TASKS=ok");

    await expect(page).toHaveURL(/#\/workbench/);
    await expect(page.getByTestId("workbench-drawer")).toBeVisible();
    await expect(page.getByTestId("workbench-drawer-tab-tasks")).toHaveAttribute(
      "data-state",
      "active",
    );
    await expect(page.getByText(/Opened from /)).toBeVisible();
    const blocked = page.getByTestId("workbench-board-blocked");
    const card = blocked.getByTestId("workbench-board-card").filter({ hasText: "前端板" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("缺接口");
    await card.click();
    await expect(
      page.getByTestId("workbench-window").filter({ hasText: "前端板" }),
    ).toHaveAttribute("data-focused", "true");

    await expect
      .poll(async () => readReplayForWindowId(page, managerId ?? ""), { timeout: 30_000 })
      .toContain("FFPANE_MCP_PANEL_PLAN=ok");
    await expect(page.getByTestId("workbench-drawer-tab-plan")).toHaveAttribute(
      "data-state",
      "active",
    );
    await expect(page.getByTestId("workbench-brief").filter({ hasText: "board.md" })).toBeVisible();
    await expect(page.getByTestId("workbench-brief-preview")).toContainText("接口清单");

    await expect
      .poll(async () => readReplayForWindowId(page, managerId ?? ""), { timeout: 30_000 })
      .toContain("FFPANE_MCP_PANEL_RUNS=ok");
    await expect(page.getByTestId("workbench-drawer-tab-runs")).toHaveAttribute(
      "data-state",
      "active",
    );
    await expect(
      page.getByTestId("workbench-thread-row").filter({ hasText: "开始吧" }),
    ).toBeVisible();
    await page.getByTestId("workbench-thread-filter-kind").selectOption("report");
    await expect(
      page.getByTestId("workbench-thread-row").filter({ hasText: "缺接口" }),
    ).toBeVisible();
    await expect(
      page.getByTestId("workbench-thread-row").filter({ hasText: "开始吧" }),
    ).toHaveCount(0);

    await expect(page.getByRole("link", { name: "Plan", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Tasks", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Runs", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Workbench", exact: true })).toBeVisible();
  } finally {
    await launched.cleanup();
  }
});

test("从会话页收到打开任务面板后，切到工作台并打开抽屉", async () => {
  test.setTimeout(120_000);
  const fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-mcp-away-"));
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-mcp-away-proj-"));
  const triggerFile = join(fakeBinDir, "open-panel.trigger");
  seedFakeClaude(fakeBinDir);
  const launched = await launchApp({
    pathPrepend: fakeBinDir,
    extraEnv: { FFPANE_WB_SCRIPT: "panel-away", FFPANE_WB_TRIGGER: triggerFile },
  });
  try {
    const { app, page } = launched;
    await createProject(app, page, projectDir, "E2E Away");
    await page.getByRole("button", { name: /^E2E Away/ }).click();
    await seedClaudeProfile(page);
    await gotoRoute(page, "/workbench");
    await page.getByTestId("workbench-new-tab").click();
    await expect(page.getByTestId("workbench-new-window-dialog")).toBeVisible();
    await page.getByTestId("workbench-new-kind-claude").click();
    await expect(page.getByTestId("workbench-new-profile")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("workbench-new-confirm")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("workbench-new-confirm").click();

    const manager = page.getByTestId("workbench-window").first();
    const managerId = await manager.getAttribute("data-window-id");
    expect(managerId).toBeTruthy();
    await expect
      .poll(async () => readReplayForWindowId(page, managerId ?? ""), { timeout: 90_000 })
      .toContain("FFPANE_MCP_HOLD=1");

    await gotoRoute(page, "/session");
    await expect(page).toHaveURL(/#\/session/);
    await expect(page.getByTestId("workbench-drawer")).toHaveCount(0);

    writeFileSync(triggerFile, "go\n", "utf8");
    await expect(page).toHaveURL(/#\/workbench/, { timeout: 30_000 });
    await expect(page.getByTestId("workbench-drawer")).toBeVisible();
    await expect(page.getByTestId("workbench-drawer-tab-tasks")).toHaveAttribute(
      "data-state",
      "active",
    );
    await expect(page.getByText(/Opened from /)).toBeVisible();
    await expect
      .poll(async () => readReplayForWindowId(page, managerId ?? ""), { timeout: 30_000 })
      .toContain("FFPANE_MCP_PANEL_TASKS=ok");
  } finally {
    await launched.cleanup();
  }
});

test("管理者写入记忆，子窗口能查到但不能写，记忆页可删除", async () => {
  test.setTimeout(120_000);
  const fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-mcp-mem-"));
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-mcp-mem-proj-"));
  seedFakeClaude(fakeBinDir);
  const launched = await launchApp({
    pathPrepend: fakeBinDir,
    extraEnv: { FFPANE_WB_SCRIPT: "memory" },
  });
  try {
    const { app, page } = launched;
    await createProject(app, page, projectDir, "E2E Memory");
    await page.getByRole("button", { name: /^E2E Memory/ }).click();
    await seedClaudeProfile(page);
    await gotoRoute(page, "/workbench");
    await page.getByTestId("workbench-new-tab").click();
    await expect(page.getByTestId("workbench-new-window-dialog")).toBeVisible();
    await page.getByTestId("workbench-new-kind-claude").click();
    await expect(page.getByTestId("workbench-new-profile")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("workbench-new-confirm")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("workbench-new-confirm").click();

    const manager = page.getByTestId("workbench-window").first();
    const managerId = await manager.getAttribute("data-window-id");
    expect(managerId).toBeTruthy();
    await expect
      .poll(async () => readReplayForWindowId(page, managerId ?? ""), { timeout: 90_000 })
      .toContain("FFPANE_MCP_MEMORY_PARENT=ok");
    const child = page.getByTestId("workbench-window").filter({ hasText: "记忆子" });
    const childId = await child.getAttribute("data-window-id");
    const childReplay = await readReplayForWindowId(page, childId ?? "");
    expect(childReplay).toContain("FFPANE_MCP_MEMORY_SEARCH=hit");
    expect(childReplay).toContain("FFPANE_MCP_MEMORY_ADD=denied");

    await gotoRoute(page, "/memory");
    await page.getByRole("tab", { name: "Candidates" }).click();
    const card = page.getByTestId("memory-entry").filter({ hasText: "窗台记忆口令" });
    await expect(card).toBeVisible();
    await expect(card.getByTestId("memory-entry-source")).toContainText("Claude 1");
    await expect(card.getByTestId("memory-entry-source")).toContainText("Manager");
    await card.getByTestId("memory-entry-delete").click();
    await expect(card).toHaveCount(0);
  } finally {
    await launched.cleanup();
  }
});
