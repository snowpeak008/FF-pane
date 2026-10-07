/**
 * T10.16：配置里有 Grok 这一路时能开窗口，项目里出现 .grok/config.toml 且不含令牌明文。
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, launchApp } from "./_launch";

function seedFakeGrok(dir: string): void {
  // 本机 PATH 上已有 grok.exe。放一个同名 exe 在更前面，避免测例启动真的 Grok。
  const node = execFileSync("where.exe", ["node"], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().endsWith("node.exe"));
  if (node !== undefined) {
    copyFileSync(node, join(dir, "grok.exe"));
  }
  const bin = join(dir, "node_modules", "grok", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "grok.js"),
    [
      "#!/usr/bin/env node",
      "const argv = process.argv.slice(2);",
      "process.stdout.write('FAKE_GROK_ARGV_JSON=' + JSON.stringify(argv) + '\\n');",
      "process.stdout.write('FAKE_GROK_ENV_TOKEN=' + (process.env.FF_PANE_WINDOW_TOKEN ? 'present' : 'absent') + '\\n');",
      "process.exit(0);",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(dir, "grok.cmd"),
    [
      "@ECHO off",
      "SETLOCAL",
      "CALL :find_dp0",
      'IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" ) ELSE ( SET "_prog=node" )',
      'endLocal & "%_prog%"  "%dp0%\\node_modules\\grok\\bin\\grok.js" %*',
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      "",
    ].join("\r\n"),
    "utf8",
  );
}

test("配置有 Grok 这一路时能开窗口，项目配置不含令牌明文", async () => {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-grok-"));
  const projectDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-grok-proj-"));
  seedFakeGrok(fakeBinDir);
  mkdirSync(join(projectDir, ".grok"), { recursive: true });
  writeFileSync(
    join(projectDir, ".grok", "config.toml"),
    '# user-kept\n[mcp_servers.my-tool]\ncommand = "my-tool"\n',
    "utf8",
  );

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
    await page.locator("#create-project-name").fill("E2E Grok");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("button", { name: /^E2E Grok/ })).toBeVisible();

    await page.evaluate(async () => {
      const invoke = (channel: string, req?: unknown) =>
        // biome-ignore lint/suspicious/noExplicitAny: E2E
        (window as any).ffpane.invoke(channel, req);
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
          grok: { connectionMode: "local_cli" },
        },
      });
    });

    await page.getByRole("button", { name: /^E2E Grok/ }).click();
    await gotoRoute(page, "/workbench");
    await page.getByTestId("workbench-new-tab").click();
    await expect(page.getByTestId("workbench-new-window-dialog")).toBeVisible();
    await page.getByTestId("workbench-new-kind-grok").click();
    await expect(page.getByTestId("workbench-new-confirm")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("workbench-new-confirm").click();

    const windowId = await page.getByTestId("workbench-window").getAttribute("data-window-id");
    expect(windowId).toBeTruthy();
    await expect(page.getByTestId("workbench-window")).toHaveAttribute("data-window-kind", "grok");

    const configPath = join(projectDir, ".grok", "config.toml");
    expect(existsSync(configPath)).toBe(true);
    const body = readFileSync(configPath, "utf8");
    expect(body).toContain("# user-kept");
    expect(body).toContain("[mcp_servers.my-tool]");
    expect(body).toContain("[mcp_servers.ffpane-workbench]");
    expect(body).toContain(`${"$"}{FF_PANE_WINDOW_TOKEN}`);
    expect(body).not.toMatch(/FF_PANE_WINDOW_TOKEN = "[0-9a-f]/i);
  } finally {
    await launched.cleanup();
    rmSync(fakeBinDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});
