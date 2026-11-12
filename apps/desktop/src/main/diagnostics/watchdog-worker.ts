/**
 * 主线程看门狗（T11.12），跑在 worker_threads 工作线程里。
 *
 * 2026-11-12 主线程卡在关窗的系统调用里（栈上有搜狗输入法），主线程上的退出看门狗、
 * 卡死弹框全部失效，进程占着单实例锁，再双击也打不开。工作线程不靠主线程，照样能跑：
 * - 主线程每 2 秒发一次心跳；
 * - 平时 60 秒没心跳只往日志里记一行（写堆快照之类可能合法地卡一阵），不杀；
 * - 关窗、退出过程中 10 秒没心跳，或者开始关窗 20 秒了还没退掉，结束本进程和整棵子进程树；
 * - 每 10 秒写一次 instance.json（pid、启动时间、最后一次收到心跳的时间），
 *   再双击时新的一份读它，判断上一份是不是卡死了。开始关窗后删掉、不再写。
 *
 * 主线程卡死时 console 也送不出去（工作线程的输出要经主线程转），所以日志直接追加写文件。
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import {
  decideWatchdogTick,
  noteBeat,
  noteClosing,
  type WatchdogLimits,
  type WatchdogState,
  watchdogLogFileName,
} from "./watchdog-policy";

export interface WatchdogWorkerData extends WatchdogLimits {
  readonly tickMs: number;
  readonly instanceWriteMs: number;
  readonly instanceFile: string;
  readonly logDir: string | null;
  readonly startedAt: number;
}

const data = workerData as WatchdogWorkerData;
let state: WatchdogState = { lastBeat: Date.now() };
let lastWrite = 0;
let killing = false;

function log(message: string): void {
  if (data.logDir === null) {
    return;
  }
  const now = new Date();
  try {
    appendFileSync(
      join(data.logDir, watchdogLogFileName(now)),
      `${now.toISOString()} error [watchdog] ${message}\n`,
    );
  } catch {
    // 写不了日志不影响看门狗本身
  }
}

function writeInstance(now: number): void {
  lastWrite = now;
  const temp = `${data.instanceFile}.tmp`;
  try {
    writeFileSync(
      temp,
      JSON.stringify({ pid: process.pid, startedAt: data.startedAt, lastBeat: state.lastBeat }),
    );
    renameSync(temp, data.instanceFile);
  } catch {
    // 写不了只是再双击时认不出卡死
  }
}

function removeInstance(): void {
  try {
    rmSync(data.instanceFile, { force: true });
  } catch {
    // ignore
  }
}

function killSelf(): void {
  if (killing) {
    return;
  }
  killing = true;
  if (process.platform === "win32") {
    // /T：终端里的 CLI 一起结束，不留孤儿
    spawnSync("taskkill", ["/F", "/T", "/PID", String(process.pid)], {
      windowsHide: true,
      stdio: "ignore",
    });
  }
  process.kill(process.pid, "SIGKILL");
}

parentPort?.on("message", (message: unknown) => {
  const type = (message as { type?: unknown } | null)?.type;
  const now = Date.now();
  if (type === "beat") {
    const beat = noteBeat(state, now);
    state = beat.state;
    if (beat.recoveredAfterMs !== undefined) {
      log(`main thread responsive again after ${Math.round(beat.recoveredAfterMs / 1000)}s`);
    }
    return;
  }
  if (type === "closing" && state.closingSince === undefined) {
    state = noteClosing(state, now);
    removeInstance();
  }
});

setInterval(() => {
  const now = Date.now();
  const decided = decideWatchdogTick(state, now, data);
  state = decided.state;
  const action = decided.action;
  if (action.kind === "log-frozen") {
    log(`main thread frozen for ${Math.round(action.silentMs / 1000)}s`);
  } else if (action.kind === "kill") {
    log(
      `${action.reason === "closing-frozen" ? "main thread frozen while closing" : "closing took too long"} (silent ${Math.round(action.silentMs / 1000)}s); killing the process tree`,
    );
    killSelf();
    return;
  }
  if (state.closingSince === undefined && now - lastWrite >= data.instanceWriteMs) {
    writeInstance(now);
  }
}, data.tickMs);

writeInstance(Date.now());
