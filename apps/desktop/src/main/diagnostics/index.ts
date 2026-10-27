/**
 * 主进程诊断与兜底（T11.0d）。
 *
 * 1.0.13 之前 FF-pane 不写日志，dev 模式下主进程的输出也看不到；10-25 至 10-27 主进程崩了
 * 十几次，只剩 Windows 的崩溃记录。这里：
 * - 主进程 console 同时写进 `<数据根>/logs/main-YYYY-MM-DD.log`，保留 7 天；
 * - 每 5 分钟记一行内存；主进程 JS 堆第一次超过 1.5GB 写一份堆快照；
 * - 界面进程没了自动重载（一分钟内 3 次后不再重载，弹框说明）；界面卡住 30 秒弹框可选重载；
 * - 子进程（GPU 等）没了记日志；超过警戒线告诉界面显示提示；
 * - 关窗退出 5 秒还没退干净就强退。
 * 判断规则在 policy.ts（纯函数）。
 */

import { createWriteStream, mkdirSync, readdirSync, rmSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { writeHeapSnapshot } from "node:v8";
import { app, type BrowserWindow, crashReporter, dialog } from "electron";
import {
  decideRendererGone,
  formatMemoryLine,
  logFileNameFor,
  MEMORY_LOG_INTERVAL_MS,
  type MemorySample,
  type MemoryWarning,
  memoryWarningOf,
  QUIT_WATCHDOG_MS,
  shouldWriteHeapSnapshot,
  staleLogFiles,
  toMb,
} from "./policy";

/** 界面卡住多久弹框。 */
const UNRESPONSIVE_PROMPT_MS = 30_000;
/** 只留最近这么多份堆快照（每份可能上 GB）。 */
const HEAP_SNAPSHOT_KEEP = 2;

let logDirectory: string | null = null;

export function diagnosticsLogDir(): string | null {
  return logDirectory;
}

/** 开 Electron 自带的崩溃记录，只存本机、不上传。要在 app ready 之前调。 */
export function startLocalCrashReporter(): void {
  try {
    crashReporter.start({ uploadToServer: false });
  } catch (thrown) {
    console.error(`[diagnostics] crashReporter failed: ${String(thrown)}`);
  }
}

/** 主进程 console 同时写进按天分的日志文件。失败只少一份日志，不影响运行。 */
export function installMainLogFile(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    for (const name of staleLogFiles(readdirSync(dir), new Date())) {
      rmSync(join(dir, name), { force: true });
    }
  } catch (thrown) {
    console.error(`[diagnostics] log dir unavailable: ${String(thrown)}`);
    return;
  }
  logDirectory = dir;
  let currentName = "";
  let stream: WriteStream | null = null;
  const write = (level: string, args: readonly unknown[]): void => {
    const now = new Date();
    const name = logFileNameFor(now);
    if (name !== currentName || stream === null) {
      stream?.end();
      currentName = name;
      stream = createWriteStream(join(dir, name), { flags: "a" });
      stream.on("error", () => {
        stream = null;
      });
    }
    stream?.write(`${now.toISOString()} ${level} ${format(...args)}\n`);
  };
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        write(level, args);
      } catch {
        // 写日志失败不能影响主流程
      }
    };
  }
  console.log(
    `[diagnostics] FF-pane ${app.getVersion()} started; logs in ${dir}; crash dumps in ${app.getPath("crashDumps")}`,
  );
}

export interface DiagnosticsOptions {
  readonly getWindow: () => BrowserWindow | null;
  readonly terminalStats: () => { readonly count: number; readonly bufferedBytes: number };
  readonly onMemoryWarning: (warning: MemoryWarning) => void;
}

/** 装上崩溃、卡死、内存记录和退出兜底。只调一次。 */
export function installDiagnostics(options: DiagnosticsOptions): void {
  let reloads: readonly number[] = [];
  let gaveUp = false;

  app.on("render-process-gone", (_event, contents, details) => {
    const window = options.getWindow();
    console.error(
      `[diagnostics] renderer gone: reason=${details.reason} exitCode=${details.exitCode}`,
    );
    if (window === null || window.isDestroyed() || contents !== window.webContents) {
      return;
    }
    const decided = decideRendererGone(details.reason, reloads, Date.now());
    reloads = decided.recent;
    if (decided.action === "reload") {
      console.error("[diagnostics] reloading the renderer");
      contents.reload();
      return;
    }
    if (decided.action === "give-up" && !gaveUp) {
      gaveUp = true;
      void dialog
        .showMessageBox(window, {
          type: "error",
          title: "FF-pane",
          message: "界面一分钟内崩溃了 3 次，已停止自动重新加载。",
          detail: `终端还在后台运行。可以再试一次，或者关掉 FF-pane 重新打开（窗口会续接）。日志在：${logDirectory ?? "（没有）"}`,
          buttons: ["再试一次", "关闭 FF-pane"],
          defaultId: 0,
          cancelId: 0,
        })
        .then(({ response }) => {
          gaveUp = false;
          if (response === 1) {
            app.quit();
            return;
          }
          reloads = [];
          if (!window.isDestroyed()) {
            window.webContents.reload();
          }
        });
    }
  });

  app.on("child-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") {
      return;
    }
    console.error(
      `[diagnostics] child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}${
        details.serviceName !== undefined ? ` service=${details.serviceName}` : ""
      }`,
    );
  });

  let watchdogArmed = false;
  app.on("before-quit", () => {
    if (watchdogArmed) {
      return;
    }
    watchdogArmed = true;
    setTimeout(() => {
      console.error(`[diagnostics] still running ${QUIT_WATCHDOG_MS}ms after quit; forcing exit`);
      app.exit(0);
    }, QUIT_WATCHDOG_MS).unref();
  });

  let snapshotWritten = false;
  const sample = (): MemorySample => {
    const usage = process.memoryUsage();
    const window = options.getWindow();
    const rendererPid =
      window !== null && !window.isDestroyed() ? window.webContents.getOSProcessId() : undefined;
    let rendererMb: number | undefined;
    let gpuMb: number | undefined;
    for (const metric of app.getAppMetrics()) {
      const kb = metric.memory.privateBytes ?? metric.memory.workingSetSize;
      if (metric.pid === rendererPid) {
        rendererMb = Math.round(kb / 1024);
      } else if (metric.type === "GPU") {
        gpuMb = Math.round(kb / 1024);
      }
    }
    const terminals = options.terminalStats();
    return {
      mainRssMb: toMb(usage.rss),
      mainHeapUsedMb: toMb(usage.heapUsed),
      mainExternalMb: toMb(usage.external),
      mainArrayBuffersMb: toMb(usage.arrayBuffers),
      ...(rendererMb !== undefined ? { rendererMb } : {}),
      ...(gpuMb !== undefined ? { gpuMb } : {}),
      terminals: terminals.count,
      terminalBufferedMb: toMb(terminals.bufferedBytes),
    };
  };
  const tick = (): void => {
    let current: MemorySample;
    try {
      current = sample();
    } catch (thrown) {
      console.error(`[diagnostics] memory sample failed: ${String(thrown)}`);
      return;
    }
    console.log(formatMemoryLine(current));
    const warning = memoryWarningOf(current);
    if (warning !== undefined) {
      console.error(`[diagnostics] memory high: ${warning.kind} ${warning.mb}MB`);
      options.onMemoryWarning(warning);
    }
    if (logDirectory !== null && shouldWriteHeapSnapshot(current, snapshotWritten)) {
      snapshotWritten = true;
      writeSnapshot(logDirectory);
    }
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, MEMORY_LOG_INTERVAL_MS).unref();
}

function writeSnapshot(dir: string): void {
  try {
    const old = readdirSync(dir)
      .filter((name) => name.endsWith(".heapsnapshot"))
      .sort();
    for (const name of old.slice(0, Math.max(0, old.length - (HEAP_SNAPSHOT_KEEP - 1)))) {
      rmSync(join(dir, name), { force: true });
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    console.error("[diagnostics] main heap is large; writing a heap snapshot (may pause a while)");
    const path = writeHeapSnapshot(join(dir, `main-${stamp}.heapsnapshot`));
    console.error(`[diagnostics] heap snapshot written: ${path}`);
  } catch (thrown) {
    console.error(`[diagnostics] heap snapshot failed: ${String(thrown)}`);
  }
}

/** 界面卡住：记日志；30 秒还没缓过来就弹框，可选强制重载（走上面的「界面进程没了」）。 */
export function watchWindowResponsiveness(window: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let prompting = false;
  window.on("unresponsive", () => {
    console.error("[diagnostics] window unresponsive");
    if (timer !== null || prompting) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (window.isDestroyed()) {
        return;
      }
      prompting = true;
      void dialog
        .showMessageBox(window, {
          type: "warning",
          title: "FF-pane",
          message: "界面已经 30 秒没有响应。",
          detail: "可以重新加载界面（终端在后台运行，不受影响），或者继续等待。",
          buttons: ["重新加载界面", "继续等待"],
          defaultId: 0,
          cancelId: 1,
        })
        .then(({ response }) => {
          prompting = false;
          if (response === 0 && !window.isDestroyed()) {
            console.error("[diagnostics] user chose to reload the unresponsive renderer");
            window.webContents.forcefullyCrashRenderer();
          }
        });
    }, UNRESPONSIVE_PROMPT_MS);
  });
  window.on("responsive", () => {
    console.error("[diagnostics] window responsive again");
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  });
}
