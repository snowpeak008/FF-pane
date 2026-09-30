/**
 * T9.4b Profile 编辑器：推理强度下拉按 Runtime 条件显示。
 *
 * 设置页新建 Profile —— 选 claude-code 或 grok-build 出现 #profile-reasoning-effort；
 * 选 gemini-cli 不出现。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

let launched: LaunchedApp;
let projectDir: string;

test.beforeAll(async () => {
  launched = await launchApp();
  projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-effort-"));

  await launched.page.evaluate(async (dir: string) => {
    const invoke = (channel: string, req?: unknown) =>
      // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
      (window as any).ffpane.invoke(channel, req);
    const entry = await invoke("projects:create", { name: "E2E Effort", rootPath: dir });
    await invoke("providers:create", {
      draft: {
        name: "E2E Effort CLI",
        type: "cli_login",
        models: [{ id: "m1", displayName: "M1", kind: "chat" }],
        defaultModel: "m1",
        enabled: true,
      },
    });
    window.localStorage.setItem(
      "ffpane.ui-state",
      JSON.stringify({ state: { activeProjectId: entry.id }, version: 1 }),
    );
  }, projectDir);
  await launched.page.reload();
  await launched.page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await launched.cleanup();
  rmSync(projectDir, { recursive: true, force: true });
});

test("claude-code / grok-build 显示 effort 下拉；gemini-cli 不显示", async () => {
  const { page } = launched;
  await gotoRoute(page, "/settings");
  await page.getByRole("button", { name: "New profile" }).click();
  await page.locator("#profile-connection").selectOption("local_cli");

  await page.locator("#profile-runtime").selectOption("claude-code");
  await expect(page.locator("#profile-reasoning-effort")).toBeVisible();

  await page.locator("#profile-runtime").selectOption("grok-build");
  await expect(page.locator("#profile-reasoning-effort")).toBeVisible();

  await page.locator("#profile-runtime").selectOption("gemini-cli");
  await expect(page.locator("#profile-reasoning-effort")).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("会话顶栏可改规划者思考强度", async () => {
  const { page } = launched;
  await gotoRoute(page, "/settings");
  await page.getByRole("button", { name: "New profile" }).click();
  await page.locator("#profile-name").fill("E2E Session Effort");
  await page.locator("#profile-connection").selectOption("local_cli");
  await page.locator("#profile-runtime").selectOption("claude-code");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("E2E Session Effort", { exact: true })).toBeVisible();

  await gotoRoute(page, "/session");
  const effort = page.locator("#session-reasoning-effort");
  await expect(effort).toBeVisible();
  await effort.selectOption("high");
  await expect(effort).toHaveValue("high");
});

test("任务页可改执行者思考强度并落盘", async () => {
  const { page } = launched;
  const tasksDir = join(projectDir, ".workbench", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(tasksDir, "task-e2e-effort.json"),
    JSON.stringify({
      id: "e2e-effort",
      planVersion: 1,
      goal: "E2E task effort",
      writeScope: [],
      forbidden: [],
      dependsOn: [],
      contextRefs: [],
      acceptance: ["ok"],
      status: "pending",
    }),
    "utf8",
  );

  await gotoRoute(page, "/settings");
  await page.getByRole("button", { name: "New profile" }).click();
  await page.locator("#profile-name").fill("E2E Worker Effort");
  await page.locator("#profile-connection").selectOption("local_cli");
  await page.locator("#profile-runtime").selectOption("codex");
  await page.locator("#profile-role").selectOption("worker");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("E2E Worker Effort", { exact: true })).toBeVisible();

  await gotoRoute(page, "/tasks");
  const effort = page.getByTestId("task-reasoning-effort-e2e-effort");
  await expect(effort).toBeVisible();
  await effort.selectOption("medium");
  await expect
    .poll(async () => {
      const tasks = await page.evaluate(async (dir: string) => {
        const invoke = (channel: string, req?: unknown) =>
          (
            window as unknown as {
              ffpane: { invoke: (c: string, r?: unknown) => Promise<unknown> };
            }
          ).ffpane.invoke(channel, req);
        return invoke("tasks:list", { projectRoot: dir }) as Promise<
          ReadonlyArray<{ id: string; reasoningEffort?: string }>
        >;
      }, projectDir);
      return tasks.find((task) => task.id === "e2e-effort")?.reasoningEffort;
    })
    .toBe("medium");
});
