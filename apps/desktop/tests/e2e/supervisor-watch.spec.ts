/**
 * 监管者挂接：管理者先开监管者再开执行，执行自动挂到监管者下。
 * 界面存过布局之后，执行汇报 done 时抄送给监管者，在线的监管者从 ffpane_wait_events 里拿到。
 * 管理者限流、监管者掉线时，汇报不打进终端，记进管理者的「待处理」，管理者窗口盖上暂停提示。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

/** 按窗口 id 从终端列表找当前活着的终端读回放，不依赖窗口在不在当前标签页。 */
async function readLiveReplay(page: LaunchedApp["page"], windowId: string): Promise<string> {
  return page.evaluate(async (wid) => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: E2E
      const list = await (window as any).ffpane.invoke("terminal:list");
      const rows = Array.isArray(list) ? list : [];
      const match = rows.find((row) => row?.metadata?.windowId === wid && row.exited !== true);
      if (typeof match?.id !== "string") {
        return "";
      }
      // biome-ignore lint/suspicious/noExplicitAny: E2E
      const replay = await (window as any).ffpane.invoke("terminal:get-replay", { id: match.id });
      return typeof replay?.data === "string" ? replay.data : "";
    } catch {
      return "";
    }
  }, windowId);
}

/** 去掉终端控制序列（长行折行时 ConPTY 会在中间插光标移动），只留文字。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 要匹配的就是终端控制序列（ESC、BEL）
const CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 同上
const OSC = /\u001b\][^\u0007]*\u0007/g;

function plain(replay: string): string {
  return replay.replace(CSI, "").replace(OSC, "");
}

function windowIdAfter(replay: string, marker: string): string {
  const tail = replay.split(marker)[1] ?? "";
  return /(win-[0-9a-f]{8}-[0-9a-f]{3})/.exec(tail)?.[1] ?? "";
}

test("执行挂到监管者下：界面存过布局后，汇报照样抄送给在线的监管者", async () => {
  test.setTimeout(150_000);
  const fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-watch-bin-"));
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-watch-proj-"));
  seedFakeClaude(fakeBinDir);
  const launched = await launchApp({
    pathPrepend: fakeBinDir,
    extraEnv: { FFPANE_WB_SCRIPT: "watch" },
  });
  try {
    const { app, page } = launched;
    await createProject(app, page, projectDir, "E2E Watch");
    const managerId = await openManagerWindow(page, "E2E Watch");
    await expect
      .poll(async () => readLiveReplay(page, managerId), { timeout: 90_000 })
      .toContain("FFPANE_WATCH_WORKER=");
    const managerReplay = await readLiveReplay(page, managerId);
    const supId = windowIdAfter(managerReplay, "FFPANE_WATCH_SUP=");
    const workerId = windowIdAfter(managerReplay, "FFPANE_WATCH_WORKER=");
    expect(supId).not.toBe("");
    expect(workerId).not.toBe("");
    expect(managerReplay).toContain("已挂到监管者");

    await expect
      .poll(async () => readLiveReplay(page, workerId), { timeout: 60_000 })
      .toContain("FFPANE_WATCH_REPORT=");
    const layouts = (await page.evaluate(async () => {
      // biome-ignore lint/suspicious/noExplicitAny: E2E
      return (window as any).ffpane.invoke("workbench:get-layouts");
    })) as Record<string, { windows: Record<string, { watcherWindowId?: string }> }>;
    const saved = Object.values(layouts)
      .map((layout) => layout.windows[workerId])
      .find((item) => item !== undefined);
    expect(saved?.watcherWindowId).toBe(supId);
    const index = readFileSync(join(projectDir, ".ffpane", "threads", "index.jsonl"), "utf8");
    const toSupervisor = index
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { to: { windowId: string }; kind: string })
      .filter((record) => record.to.windowId === supId && record.kind === "report");
    expect(toSupervisor).toHaveLength(1);
    await expect
      .poll(async () => readLiveReplay(page, supId), { timeout: 30_000 })
      .toContain("FFPANE_WATCH_GOT=");
  } finally {
    await launched.cleanup();
  }
});

test("管理者限流、监管者掉线：汇报记进待处理，不打进终端；管理者窗口盖上暂停提示", async () => {
  test.setTimeout(180_000);
  const fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-team-bin-"));
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-team-proj-"));
  seedFakeClaude(fakeBinDir);
  const launched = await launchApp({
    pathPrepend: fakeBinDir,
    // 掉线判定在测试里缩到 2 秒（正式是 5 分钟）。
    extraEnv: { FFPANE_WB_SCRIPT: "team", FF_PANE_ONLINE_GRACE_MS: "2000" },
  });
  try {
    const { app, page } = launched;
    await createProject(app, page, projectDir, "E2E Team");
    const managerId = await openManagerWindow(page, "E2E Team");
    await expect
      .poll(async () => readLiveReplay(page, managerId), { timeout: 90_000 })
      .toContain("FFPANE_TEAM_MANAGER_LIMITED=1");
    const managerReplay = await readLiveReplay(page, managerId);
    const workerId = windowIdAfter(managerReplay, "FFPANE_TEAM_WORKER=");
    expect(workerId).not.toBe("");

    await expect
      .poll(async () => readLiveReplay(page, workerId), { timeout: 60_000 })
      .toContain("FFPANE_TEAM_REPORT=");
    const workerReplay = await readLiveReplay(page, workerId);
    expect(workerReplay).toContain("已记进它的待处理");

    const digest = join(projectDir, ".ffpane", "briefs", `待处理-${managerId}.md`);
    await expect.poll(() => existsSync(digest), { timeout: 30_000 }).toBe(true);
    expect(readFileSync(digest, "utf8")).toContain(workerId);
    // 汇报没有打进管理者的终端。
    expect(await readLiveReplay(page, managerId)).not.toContain("[新消息]");

    const overlay = page.getByTestId("workbench-team-paused");
    await expect(overlay).toBeVisible({ timeout: 60_000 });
    await expect(overlay).toContainText("账号限流");
    await overlay.getByTestId("workbench-team-paused-dismiss").click();
    await expect(overlay).toHaveCount(0);

    // 用户叫醒管理者、这一轮正常结束：只收到一句「待处理」，不是逐条的汇报。
    await expect
      .poll(async () => plain(await readLiveReplay(page, managerId)), { timeout: 90_000 })
      .toContain("FFPANE_TEAM_TYPED=[待处理]");
    const woke = plain(await readLiveReplay(page, managerId));
    expect(woke.split("FFPANE_TEAM_TYPED=").length - 1).toBe(1);
    expect(woke).toContain(`待处理-${managerId}.md`);
    expect(woke).not.toContain("FFPANE_TEAM_TYPED=[新消息]");
  } finally {
    await launched.cleanup();
  }
});
