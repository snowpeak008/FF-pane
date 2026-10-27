/**
 * T11.0d：主进程写日志；界面进程没了自动重载；只开一份。
 */

import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { desktopDir, launchApp } from "./_launch";

function mainLog(dataRoot: string): string {
  const dir = join(dataRoot, "logs");
  return readdirSync(dir)
    .filter((name) => name.startsWith("main-") && name.endsWith(".log"))
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("");
}

test("界面进程没了自动重载，日志里有记录", async () => {
  const launched = await launchApp();
  try {
    const { app, dataRoot } = launched;
    expect(mainLog(dataRoot)).toContain("[diagnostics] FF-pane");

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer();
    });
    await expect.poll(() => mainLog(dataRoot)).toContain("renderer gone");
    await expect.poll(() => mainLog(dataRoot)).toContain("reloading the renderer");
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const contents = BrowserWindow.getAllWindows()[0]?.webContents;
          return contents !== undefined && !contents.isCrashed() && !contents.isLoading();
        }),
      )
      .toBe(true);
    // 崩过的页面 Playwright 接不回来，从主进程看重载后的页面。
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript(
            "document.querySelector('nav') !== null",
          ),
        ),
      )
      .toBe(true);
  } finally {
    await launched.cleanup();
  }
});

test("同一份数据再启动一次：新的那份直接退出，原来的还在", async () => {
  const launched = await launchApp();
  try {
    const electronPath = createRequire(import.meta.url)("electron") as unknown as string;
    const second = spawn(electronPath, [".", `--user-data-dir=${launched.userDataDir}`], {
      cwd: desktopDir,
      env: { ...launched.env },
      stdio: "ignore",
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        second.kill();
        reject(new Error("second instance did not exit within 20s"));
      }, 20_000);
      second.on("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    expect(code).toBe(0);
    await expect(launched.page.locator("nav")).toBeVisible();
  } finally {
    await launched.cleanup();
  }
});
