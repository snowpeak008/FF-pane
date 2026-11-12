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

import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  type WriteStream,
} from "node:fs";
import { basename, join } from "node:path";
import { format } from "node:util";
import { writeHeapSnapshot } from "node:v8";
import { app, type BrowserWindow, crashReporter, dialog } from "electron";
import {
  decideRendererGone,
  describeSilence,
  formatMemoryLine,
  logFileNameFor,
  MEMORY_LOG_INTERVAL_MS,
  type MemorySample,
  type MemoryWarning,
  memoryWarningOf,
  QUIT_WATCHDOG_MS,
  STALE_RECHECK_MS,
  shouldWriteHeapSnapshot,
  staleCrashReports,
  staleLogFiles,
  toMb,
} from "./policy";
import { endInstance } from "./watchdog";

/** 界面卡住多久弹框。 */
const UNRESPONSIVE_PROMPT_MS = 30_000;
/** 只留最近这么多份堆快照（每份可能上 GB）。 */
const HEAP_SNAPSHOT_KEEP = 2;

/** 结束卡死的上一份后，最多等它退干净多久。 */
const END_STALE_TIMEOUT_MS = 10_000;

export { type MainWatchdog, readStaleInstance, startMainWatchdog } from "./watchdog";

let logDirectory: string | null = null;

/**
 * 再双击时上一份卡死了（T11.12）：过一会儿再确认一次，然后问要不要结束它重新打开。
 * 返回 true 表示上一份已经结束，可以接着拿单实例锁正常启动；false 表示照旧退出。
 * 要在 app ready 之后调（要弹框）。开发态可用 FF_PANE_TEST_STALE_CHOICE=end|cancel 跳过弹框（e2e 用）。
 */
export async function offerToEndStaleInstance(
  readStale: (now: number) => { readonly pid: number; readonly lastBeat: number } | undefined,
): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, STALE_RECHECK_MS));
  const now = Date.now();
  const stale = readStale(now);
  if (stale === undefined) {
    return false;
  }
  const testChoice = app.isPackaged ? undefined : process.env["FF_PANE_TEST_STALE_CHOICE"];
  let end: boolean;
  if (testChoice === "end" || testChoice === "cancel") {
    end = testChoice === "end";
  } else {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      title: "FF-pane",
      message: `上一个 FF-pane 已经 ${describeSilence(now - stale.lastBeat)}没有响应。`,
      detail:
        "结束它并重新打开吗？终端里的 AI 窗口会一起结束，重开后自动续接；正在回复的那一轮会丢。",
      buttons: ["结束并重新打开", "取消"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    end = response === 0;
  }
  if (!end) {
    return false;
  }
  const ended = await endInstance(stale.pid, END_STALE_TIMEOUT_MS);
  if (!ended) {
    dialog.showErrorBox(
      "FF-pane",
      `没能结束上一个 FF-pane（进程 ${stale.pid}）。请在任务管理器里结束 ${basename(process.execPath)} 后再打开。`,
    );
  }
  return ended;
}

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
  // 启动 1 分钟后清一次旧崩溃记录（T11.12），避开启动高峰
  setTimeout(() => pruneCrashReports(join(app.getPath("crashDumps"), "reports")), 60_000).unref();
}

function pruneCrashReports(dir: string): void {
  let entries: { readonly name: string; readonly mtimeMs: number }[];
  try {
    entries = readdirSync(dir).map((name) => ({
      name,
      mtimeMs: statSync(join(dir, name)).mtimeMs,
    }));
  } catch {
    return;
  }
  const stale = staleCrashReports(entries, Date.now());
  for (const name of stale) {
    rmSync(join(dir, name), { force: true });
  }
  if (stale.length > 0) {
    console.log(`[diagnostics] removed ${stale.length} old crash report(s)`);
  }
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

/** 界面每 5 分钟写的内存行（JS 堆、终端图集），收进主进程日志。 */
const RENDERER_REPORT_PREFIX = "[renderer-mem]";

export function forwardRendererReports(window: BrowserWindow): void {
  window.webContents.on("console-message", (details) => {
    if (details.message.startsWith(RENDERER_REPORT_PREFIX)) {
      console.log(details.message);
    }
  });
}

/** GPU 进程的一行状态（界面卡住时记进日志）。 */
function describeGpuProcess(): string {
  const gpu = app.getAppMetrics().find((metric) => metric.type === "GPU");
  if (gpu === undefined) {
    return "gpu process: none";
  }
  const mb = Math.round((gpu.memory.privateBytes ?? gpu.memory.workingSetSize) / 1024);
  return `gpu process: pid=${gpu.pid} mem=${mb}MB cpu=${gpu.cpu.percentCPUUsage.toFixed(1)}%`;
}

/** 结束 GPU 进程，Chromium 会自己重开一个。返回有没有结束。 */
function restartGpuProcess(): boolean {
  const gpu = app.getAppMetrics().find((metric) => metric.type === "GPU");
  if (gpu === undefined) {
    return false;
  }
  try {
    process.kill(gpu.pid);
    console.error(`[diagnostics] killed gpu process ${gpu.pid}; chromium relaunches it`);
    return true;
  } catch (thrown) {
    console.error(`[diagnostics] could not kill gpu process ${gpu.pid}: ${String(thrown)}`);
    return false;
  }
}

/**
 * 界面卡住：记日志；30 秒还没缓过来就弹框，可选重新加载。
 * T11.12：2026-11-12 界面卡在等 GPU 进程回话（建图形上下文的同步调用），光重载界面还会卡在同一个
 * GPU 进程上，所以重新加载时先结束 GPU 进程（Chromium 自己重开），再重载界面。
 * 窗口最小化或藏起来时弹框不挂在它上面，不然弹框也跟着看不见。
 */
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
      console.error(`[diagnostics] still unresponsive after 30s; ${describeGpuProcess()}`);
      prompting = true;
      const options = {
        type: "warning" as const,
        title: "FF-pane",
        message: "界面已经 30 秒没有响应。",
        detail: "可以重新加载界面（终端在后台运行，不受影响），或者继续等待。",
        buttons: ["重新加载界面", "继续等待"],
        defaultId: 0,
        cancelId: 1,
      };
      const visible = window.isVisible() && !window.isMinimized();
      void (visible ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)).then(
        ({ response }) => {
          prompting = false;
          if (response === 0 && !window.isDestroyed()) {
            console.error("[diagnostics] user chose to reload the unresponsive renderer");
            restartGpuProcess();
            window.webContents.forcefullyCrashRenderer();
          }
        },
      );
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
