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

test("T11.13 界面卡住、GPU 进程不动：自动结束 GPU 进程，缓过来后弹框自动收起", async () => {
  test.setTimeout(150_000);
  const launched = await launchApp();
  try {
    const { app, dataRoot } = launched;
    const emit = (name: "unresponsive" | "responsive"): Promise<void> =>
      app.evaluate(({ BrowserWindow }, event) => {
        BrowserWindow.getAllWindows()[0]?.emit(event);
      }, name);
    // 真卡住要有系统级输入等着界面处理，Chromium 才发这个事件（合成输入不算），这里直接发。
    // 界面闲着时 GPU 进程也几乎不用 CPU，和 11-13 卡在崩溃处理里一样。
    const gpuBefore = await app.evaluate(
      ({ app: electronApp }) =>
        electronApp.getAppMetrics().find((metric) => metric.type === "GPU")?.pid,
    );
    await emit("unresponsive");
    const timing = { timeout: 60_000, intervals: [1_000] };
    await expect.poll(() => mainLog(dataRoot), timing).toContain("gpu process used almost no cpu");
    expect(mainLog(dataRoot)).toContain(`killed gpu process ${gpuBefore}`);
    await expect
      .poll(
        () =>
          app.evaluate(
            ({ app: electronApp }) =>
              electronApp.getAppMetrics().find((metric) => metric.type === "GPU")?.pid,
          ),
        timing,
      )
      .not.toBe(gpuBefore);
    // 自动结束 GPU 进程后 15 秒还算没缓过来：弹框；缓过来时弹框自动收起。
    await expect.poll(() => mainLog(dataRoot), timing).toContain("asking whether to reload");
    await emit("responsive");
    await expect.poll(() => mainLog(dataRoot), timing).toContain("closing the unresponsive prompt");
    expect(mainLog(dataRoot)).not.toContain("user chose to reload");
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript(
          "document.querySelector('nav') !== null",
        ),
      ),
    ).toBe(true);
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

/** 进程还在不在（Windows 下 process.kill(pid, 0) 只看得出句柄能不能开，够用）。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("T11.12 关窗时主线程卡死：看门狗 10 秒左右结束整个进程", async () => {
  test.setTimeout(90_000);
  const launched = await launchApp({ extraEnv: { FF_PANE_TEST_FREEZE_MAIN: "close" } });
  try {
    const { app, dataRoot } = launched;
    const pid = app.process().pid;
    expect(pid).toBeDefined();
    // 先让 evaluate 返回，再关窗（关窗处理里主线程会卡住）
    await app.evaluate(({ BrowserWindow }) => {
      setTimeout(() => BrowserWindow.getAllWindows()[0]?.close(), 200);
    });
    const closedAt = Date.now();
    await expect
      .poll(() => isAlive(pid as number), { timeout: 30_000, intervals: [500] })
      .toBe(false);
    expect(Date.now() - closedAt).toBeGreaterThan(8_000);
    expect(mainLog(dataRoot)).toContain("[watchdog] main thread frozen while closing");
  } finally {
    await launched.cleanup();
  }
});

test("T11.12 上一份卡死：再起一份时结束它，新的一份接着正常启动", async () => {
  test.setTimeout(150_000);
  // 启动收尾（切语言、改配置）要走主线程，留够时间再卡
  const launched = await launchApp({ extraEnv: { FF_PANE_TEST_FREEZE_MAIN: "after:8000" } });
  let second: ReturnType<typeof spawn> | undefined;
  try {
    const { app, dataRoot, userDataDir } = launched;
    const frozenPid = app.process().pid as number;
    const instanceFile = join(userDataDir, "instance.json");
    // 卡住 30 秒后 instance.json 里的心跳才算过期
    await expect
      .poll(
        () => {
          try {
            const info = JSON.parse(readFileSync(instanceFile, "utf8")) as { lastBeat: number };
            return Date.now() - info.lastBeat;
          } catch {
            return 0;
          }
        },
        { timeout: 60_000, intervals: [1_000] },
      )
      .toBeGreaterThan(32_000);

    const electronPath = createRequire(import.meta.url)("electron") as unknown as string;
    const env: Record<string, string> = { ...launched.env, FF_PANE_TEST_STALE_CHOICE: "end" };
    delete env["FF_PANE_TEST_FREEZE_MAIN"];
    second = spawn(electronPath, [".", `--user-data-dir=${userDataDir}`], {
      cwd: desktopDir,
      env,
      stdio: "ignore",
    });
    const secondPid = second.pid as number;
    // 新的一份先等 13 秒重读，再结束卡死的那份
    await expect
      .poll(() => isAlive(frozenPid), { timeout: 45_000, intervals: [1_000] })
      .toBe(false);
    // 然后拿到锁正常启动：自己写 instance.json，人还在
    await expect
      .poll(
        () => {
          try {
            return (JSON.parse(readFileSync(instanceFile, "utf8")) as { pid: number }).pid;
          } catch {
            return 0;
          }
        },
        { timeout: 30_000, intervals: [1_000] },
      )
      .toBe(secondPid);
    expect(isAlive(secondPid)).toBe(true);
    expect(mainLog(dataRoot).match(/\[diagnostics\] FF-pane .* started/g)?.length).toBe(2);
  } finally {
    if (second?.pid !== undefined && isAlive(second.pid)) {
      spawn("taskkill", ["/F", "/T", "/PID", String(second.pid)], { stdio: "ignore" });
    }
    await launched.cleanup();
  }
});
