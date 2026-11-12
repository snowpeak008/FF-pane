/**
 * 主线程看门狗的主进程这一侧（T11.12）：拉起工作线程、发心跳；再双击时认出卡死的上一份并结束它。
 * 工作线程本身见 watchdog-worker.ts。
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { app } from "electron";
import {
  CLOSING_FROZEN_KILL_MS,
  CLOSING_MAX_MS,
  INSTANCE_WRITE_MS,
  type InstanceInfo,
  isInstanceStale,
  MAIN_FROZEN_LOG_MS,
  parseInstanceInfo,
  WATCHDOG_BEAT_MS,
  WATCHDOG_TICK_MS,
} from "./policy";
import type { WatchdogWorkerData } from "./watchdog-worker";

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** 和单实例锁同一个范围：都按 userData 算。 */
export function instanceFilePath(): string {
  return join(app.getPath("userData"), "instance.json");
}

export interface MainWatchdog {
  /** 开始关窗或退出：之后卡住就强退，不再写 instance.json。 */
  markClosing(): void;
}

export function startMainWatchdog(options: { readonly logDir: string | null }): MainWatchdog {
  // 打包后 asar 里的文件交给工作线程不一定读得到，看门狗脚本解包放（electron-builder asarUnpack）。
  const script = join(moduleDir, "watchdog-worker.mjs").replace(
    /app\.asar([\\/])/,
    "app.asar.unpacked$1",
  );
  const workerData: WatchdogWorkerData = {
    frozenLogMs: MAIN_FROZEN_LOG_MS,
    closingFrozenKillMs: CLOSING_FROZEN_KILL_MS,
    closingMaxMs: CLOSING_MAX_MS,
    tickMs: WATCHDOG_TICK_MS,
    instanceWriteMs: INSTANCE_WRITE_MS,
    instanceFile: instanceFilePath(),
    logDir: options.logDir,
    startedAt: Date.now(),
  };
  let worker: Worker | null = null;
  try {
    worker = new Worker(script, { workerData });
    worker.unref();
    worker.on("error", (thrown) => {
      console.error(`[watchdog] worker failed: ${String(thrown)}`);
      worker = null;
    });
  } catch (thrown) {
    console.error(`[watchdog] worker not started: ${String(thrown)}`);
  }
  const post = (type: "beat" | "closing"): void => {
    try {
      worker?.postMessage({ type });
    } catch {
      // 工作线程没了只是少一层兜底
    }
  };
  setInterval(() => post("beat"), WATCHDOG_BEAT_MS).unref();
  post("beat");
  return { markClosing: () => post("closing") };
}

/** 这个进程还在不在，而且还是 FF-pane（同一个可执行文件）。进程号会被别的程序复用。 */
export function isSameAppProcessAlive(pid: number): boolean {
  if (process.platform !== "win32") {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const line = result.stdout?.trim() ?? "";
  const image = /^"([^"]+)","(\d+)"/.exec(line);
  return (
    image !== null &&
    Number(image[2]) === pid &&
    image[1]?.toLowerCase() === basename(process.execPath).toLowerCase()
  );
}

/** 上一份 FF-pane 卡死了就返回它的记录；没有、正常、或者进程已经没了都返回 undefined。 */
export function readStaleInstance(now: number): InstanceInfo | undefined {
  let text: string;
  try {
    text = readFileSync(instanceFilePath(), "utf8");
  } catch {
    return undefined;
  }
  const info = parseInstanceInfo(text);
  if (info === undefined || info.pid === process.pid || !isInstanceStale(info, now)) {
    return undefined;
  }
  return isSameAppProcessAlive(info.pid) ? info : undefined;
}

/** 结束上一份和它的整棵子进程树，等它真的没了（最多 timeoutMs）。 */
export async function endInstance(pid: number, timeoutMs: number): Promise<boolean> {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 已经没了
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isSameAppProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return !isSameAppProcessAlive(pid);
}
