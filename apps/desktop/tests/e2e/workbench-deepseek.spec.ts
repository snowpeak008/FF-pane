/**
 * T10.17：假的 claude 能开出 DeepSeek 窗口。实际启动的是 Claude，窗口种类是 DeepSeek。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, launchApp } from "./_launch";

function seedFakeClaude(dir: string): void {
  const bin = join(dir, "node_modules", "claude", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "claude.js"),
    [
      "#!/usr/bin/env node",
      "const argv = process.argv.slice(2);",
      "process.stdout.write('FAKE_CLAUDE_ARGV_JSON=' + JSON.stringify(argv) + '\\n');",
      "process.stdout.write('FAKE_CLAUDE_ENV_ANTHROPIC_BASE_URL=' + (process.env.ANTHROPIC_BASE_URL || '') + '\\n');",
      "process.stdout.write('FAKE_CLAUDE_ENV_ANTHROPIC_MODEL=' + (process.env.ANTHROPIC_MODEL || '') + '\\n');",
      "process.stdout.write('FAKE_CLAUDE_ENV_ANTHROPIC_AUTH_TOKEN=' + (process.env.ANTHROPIC_AUTH_TOKEN ? 'present' : 'absent') + '\\n');",
      "process.exit(0);",
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

test("配置有 DeepSeek 这一路时，假的 claude 能开出 DeepSeek 窗口", async () => {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-deepseek-"));
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-deepseek-proj-"));
  seedFakeClaude(fakeBinDir);

  const launched = await launchApp({ pathPrepend: fakeBinDir });
  try {
    const { app, page } = launched;
    await app.evaluate(async ({ dialog }, path) => {
      // biome-ignore lint/suspicious/noExplicitAny: E2E 打桩
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, projectDir);
    await gotoRoute(page, "/projects");
    await page.getByRole("button", { name: "New project" }).click();
    await page.getByRole("button", { name: /Choose directory/i }).click();
    await page.locator("#create-project-name").fill("E2E DeepSeek");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("button", { name: /^E2E DeepSeek/ })).toBeVisible();

    await page.evaluate(async () => {
      const invoke = (channel: string, req?: unknown) =>
        // biome-ignore lint/suspicious/noExplicitAny: E2E
        (window as any).ffpane.invoke(channel, req);
      const provider = (await invoke("providers:create", {
        draft: {
          name: "DeepSeek",
          templateId: "deepseek",
          models: [],
          enabled: true,
        },
        apiKey: "e2e-deepseek-key",
      })) as { id: string };
      const configs = (await invoke("configs:list")) as Array<{
        id: string;
        name: string;
        isDefault: boolean;
        claude?: { connectionMode: string };
        codex?: { connectionMode: string };
      }>;
      const current = configs.find((item) => item.isDefault) ?? configs[0];
      if (current === undefined) {
        throw new Error("missing config");
      }
      await invoke("configs:update", {
        id: current.id,
        draft: {
          name: current.name,
          isDefault: true,
          ...(current.claude !== undefined ? { claude: current.claude } : {}),
          ...(current.codex !== undefined ? { codex: current.codex } : {}),
          deepseek: {
            connectionMode: "relay",
            providerId: provider.id,
            model: "deepseek-chat",
          },
        },
      });
    });

    await page.getByRole("button", { name: /^E2E DeepSeek/ }).click();
    await gotoRoute(page, "/workbench");
    await page.getByTestId("workbench-new-tab").click();
    await expect(page.getByTestId("workbench-new-window-dialog")).toBeVisible();
    await page.getByTestId("workbench-new-kind-deepseek").click();
    await expect(page.getByTestId("workbench-deepseek-hint")).toBeVisible();
    await expect(page.getByTestId("workbench-new-confirm")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("workbench-new-confirm").click();

    const windowId = await page.getByTestId("workbench-window").getAttribute("data-window-id");
    expect(windowId).toBeTruthy();
    await expect(page.getByTestId("workbench-window")).toHaveAttribute(
      "data-window-kind",
      "deepseek",
    );
    await expect(page.getByTestId("workbench-window")).toContainText("DeepSeek");

    await expect
      .poll(
        async () => {
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
        },
        { timeout: 20_000 },
      )
      .toContain("FAKE_CLAUDE_ARGV_JSON=");

    const text = await page.evaluate(async (wid) => {
      const host = document.querySelector(`[data-window-id="${wid}"]`);
      const id = host?.querySelector('[data-testid="terminal-id"]')?.textContent?.trim();
      // biome-ignore lint/suspicious/noExplicitAny: E2E
      const replay = await (window as any).ffpane.invoke("terminal:get-replay", { id });
      return typeof replay?.data === "string" ? replay.data : "";
    }, windowId);
    expect(text).toContain("--session-id");
    expect(text).toContain("deepseek-chat");
    expect(text).toContain("https://api.deepseek.com/anthropic");
    expect(text).toContain("FAKE_CLAUDE_ENV_ANTHROPIC_AUTH_TOKEN=present");
    expect(text).not.toContain("e2e-deepseek-key");
  } finally {
    await launched.cleanup();
    rmSync(fakeBinDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});
