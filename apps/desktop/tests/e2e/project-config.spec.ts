/**
 * T10.12a：没有档案也能按默认配置开窗口；只配一路时另一路被拒；收窄范围被拦。
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, launchApp } from "./_launch";

function seedFakeCli(dir: string, name: "claude" | "codex"): void {
  const bin = join(dir, "node_modules", name, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, `${name}.js`),
    "process.stdout.write('ok\\n'); process.stdin.resume();\n",
    "utf8",
  );
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

test("没有档案时默认配置能开 Claude 和 Codex", async () => {
  const fakeBin = mkdtempSync(join(tmpdir(), "ffpane-e2e-cfg-bin-"));
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-cfg-proj-"));
  seedFakeCli(fakeBin, "claude");
  seedFakeCli(fakeBin, "codex");
  const launched = await launchApp({ pathPrepend: fakeBin });
  try {
    const { app, page } = launched;
    await app.evaluate(async ({ dialog }, path) => {
      // biome-ignore lint/suspicious/noExplicitAny: E2E 打桩
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, projectDir);
    await gotoRoute(page, "/projects");
    await page.getByRole("button", { name: "New project" }).click();
    await page.getByRole("button", { name: /Choose directory/i }).click();
    await page.locator("#create-project-name").fill("E2E Config");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByRole("button", { name: /^E2E Config/ }).click();
    await gotoRoute(page, "/workbench");

    for (const kind of ["claude", "codex"] as const) {
      await page.getByTestId("workbench-new-tab").click();
      await page.getByTestId(`workbench-new-kind-${kind}`).click();
      await expect(page.getByTestId("workbench-new-route")).toContainText("Local login");
      await expect(page.getByTestId("workbench-new-confirm")).toBeEnabled({ timeout: 15_000 });
      await page.getByTestId("workbench-new-confirm").click();
      const pane = page.locator(`[data-window-kind="${kind}"]`).last();
      await expect(pane.getByTestId("workbench-window-route")).toContainText("Local login", {
        timeout: 20_000,
      });
    }
  } finally {
    await launched.cleanup();
  }
});

test("配置只配 Claude 时不能开 Codex", async () => {
  const fakeBin = mkdtempSync(join(tmpdir(), "ffpane-e2e-cfg-one-"));
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-cfg-one-proj-"));
  seedFakeCli(fakeBin, "claude");
  seedFakeCli(fakeBin, "codex");
  const launched = await launchApp({ pathPrepend: fakeBin });
  try {
    const { page } = launched;
    await page.evaluate(async (dir: string) => {
      const invoke = (channel: string, req?: unknown) =>
        // biome-ignore lint/suspicious/noExplicitAny: E2E
        (window as any).ffpane.invoke(channel, req);
      const entry = await invoke("projects:create", { name: "E2E One Route", rootPath: dir });
      const configs = (await invoke("configs:list")) as Array<{
        id: string;
        name: string;
        isDefault: boolean;
      }>;
      const current = configs.find((item) => item.isDefault) ?? configs[0];
      if (current === undefined) {
        throw new Error("missing default config");
      }
      await invoke("configs:update", {
        id: current.id,
        draft: {
          name: current.name,
          isDefault: true,
          claude: { connectionMode: "local_cli" },
        },
      });
      window.localStorage.setItem(
        "ffpane.ui-state",
        JSON.stringify({ state: { activeProjectId: entry.id }, version: 2 }),
      );
    }, projectDir);
    await page.reload();
    await gotoRoute(page, "/workbench");
    await page.getByTestId("workbench-new-tab").click();
    await page.getByTestId("workbench-new-kind-codex").click();
    await expect(page.getByTestId("workbench-route-missing")).toBeVisible();
    await expect(page.getByTestId("workbench-new-confirm")).toBeDisabled();
    await page.getByTestId("workbench-new-kind-claude").click();
    await expect(page.getByTestId("workbench-new-confirm")).toBeEnabled({ timeout: 15_000 });
  } finally {
    await launched.cleanup();
  }
});

test("收窄配置范围时，名单外仍绑定的项目会拦住保存", async () => {
  const alphaDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-cfg-a-"));
  const betaDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-cfg-b-"));
  const launched = await launchApp();
  try {
    const { page } = launched;
    const created = await page.evaluate(
      async (dirs: { alpha: string; beta: string }) => {
        const invoke = (channel: string, req?: unknown) =>
          // biome-ignore lint/suspicious/noExplicitAny: E2E
          (window as any).ffpane.invoke(channel, req);
        const alpha = await invoke("projects:create", { name: "E2E Inside", rootPath: dirs.alpha });
        const beta = await invoke("projects:create", { name: "E2E Outside", rootPath: dirs.beta });
        return { alpha, beta };
      },
      { alpha: alphaDir, beta: betaDir },
    );
    await gotoRoute(page, "/settings");
    await page.getByTestId("config-new").click();
    await page.getByTestId("config-name").fill("Narrow Me");
    await page.getByTestId("config-save").click();
    await expect(page.getByText("Narrow Me", { exact: true })).toBeVisible();
    const configId = await page.evaluate(async () => {
      const invoke = (channel: string, req?: unknown) =>
        // biome-ignore lint/suspicious/noExplicitAny: E2E
        (window as any).ffpane.invoke(channel, req);
      const configs = (await invoke("configs:list")) as Array<{ id: string; name: string }>;
      return configs.find((item) => item.name === "Narrow Me")?.id ?? "";
    });
    expect(configId).not.toBe("");
    await gotoRoute(page, "/projects");
    await page.getByTestId(`project-bind-config-${created.beta.id}`).click();
    await expect(
      page.getByTestId("project-config-select").locator(`option[value="${configId}"]`),
    ).toHaveCount(1);
    await page.getByTestId("project-config-select").selectOption(configId);
    await page.getByTestId("project-config-save").click();
    await gotoRoute(page, "/settings");
    await page.getByTestId(`config-edit-${configId}`).click();
    await expect(page.getByTestId(`config-scope-${created.alpha.id}`)).toBeVisible();
    await page.getByTestId(`config-scope-${created.alpha.id}`).check();
    await page.getByTestId("config-save").click();
    await expect(page.getByTestId("config-editor-error")).toContainText("E2E Outside");
  } finally {
    await launched.cleanup();
  }
});

test("新开窗口的权限初值先看配置，没有则用全局默认；全放开仍要确认", async () => {
  const fakeBin = mkdtempSync(join(tmpdir(), "ffpane-e2e-cfg-perm-bin-"));
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-cfg-perm-proj-"));
  seedFakeCli(fakeBin, "claude");
  const launched = await launchApp({ pathPrepend: fakeBin });
  try {
    const { page } = launched;
    await page.evaluate(async (dir: string) => {
      const invoke = (channel: string, req?: unknown) =>
        // biome-ignore lint/suspicious/noExplicitAny: E2E
        (window as any).ffpane.invoke(channel, req);
      const entry = await invoke("projects:create", { name: "E2E Perm", rootPath: dir });
      await invoke("config:update", { defaultWorkbenchPermission: "read-only" });
      window.localStorage.setItem(
        "ffpane.ui-state",
        JSON.stringify({ state: { activeProjectId: entry.id }, version: 2 }),
      );
    }, projectDir);
    await page.reload();
    await gotoRoute(page, "/workbench");
    await page.getByTestId("workbench-new-tab").click();
    await page.getByTestId("workbench-new-kind-claude").click();
    await expect(page.getByTestId("workbench-new-permission-read-only")).toHaveClass(/bg-primary/);
    await expect(page.getByTestId("workbench-new-confirm")).toBeEnabled({ timeout: 15_000 });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    await page.evaluate(async () => {
      const invoke = (channel: string, req?: unknown) =>
        // biome-ignore lint/suspicious/noExplicitAny: E2E
        (window as any).ffpane.invoke(channel, req);
      const configs = (await invoke("configs:list")) as Array<{
        id: string;
        name: string;
        isDefault: boolean;
      }>;
      const current = configs.find((item) => item.isDefault) ?? configs[0];
      if (current === undefined) {
        throw new Error("missing default config");
      }
      await invoke("configs:update", {
        id: current.id,
        draft: {
          name: current.name,
          isDefault: true,
          defaultPermission: "edit-exec",
          claude: { connectionMode: "local_cli" },
          codex: { connectionMode: "local_cli" },
        },
      });
    });
    await page.reload();
    await gotoRoute(page, "/workbench");
    await page.getByTestId("workbench-new-tab").click();
    await page.getByTestId("workbench-new-kind-claude").click();
    await expect(page.getByTestId("workbench-new-permission-edit-exec")).toHaveClass(/bg-primary/);
    await expect(page.getByTestId("workbench-new-permission-read-only")).not.toHaveClass(
      /bg-primary/,
    );
    await page.getByTestId("workbench-new-permission-yolo").click();
    await expect(page.getByTestId("workbench-new-yolo-confirm")).toBeVisible();
    await expect(page.getByTestId("workbench-new-confirm")).toBeDisabled();
    await page.getByTestId("workbench-new-yolo-confirm").check();
    await expect(page.getByTestId("workbench-new-confirm")).toBeEnabled({ timeout: 15_000 });
  } finally {
    await launched.cleanup();
  }
});
