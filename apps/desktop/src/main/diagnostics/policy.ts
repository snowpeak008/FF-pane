/**
 * 诊断与兜底的判断规则（T11.0d）。纯函数，不碰 Electron，单测直接测。
 */

/** 一分钟内界面进程没了几次就不再自动重载。 */
export const RENDERER_RELOAD_WINDOW_MS = 60_000;
export const RENDERER_RELOAD_MAX = 3;

/** 主进程 JS 堆第一次超过这个数就写一份堆快照（一次运行只写一次）。 */
export const HEAP_SNAPSHOT_MB = 1536;
/** 主进程或界面进程超过这个数就提示重启。 */
export const MEMORY_WARN_MB = 2560;
/** 内存记录间隔。 */
export const MEMORY_LOG_INTERVAL_MS = 5 * 60_000;
/** 日志保留天数。 */
export const LOG_KEEP_DAYS = 7;
/** 关窗退出超过这么久还没退干净就强退。 */
export const QUIT_WATCHDOG_MS = 5_000;

/** 主线程给看门狗工作线程发心跳的间隔（T11.12）。 */
export const WATCHDOG_BEAT_MS = 2_000;
/** 看门狗每隔多久判断一次。 */
export const WATCHDOG_TICK_MS = 1_000;
/** 平时主线程多久没心跳就记一行「冻住」。不杀：写堆快照之类可能合法地卡一阵。 */
export const MAIN_FROZEN_LOG_MS = 60_000;
/** 关窗、退出过程中主线程多久没心跳就强退整棵进程树。 */
export const CLOSING_FROZEN_KILL_MS = 10_000;
/** 关窗、退出开始后最多等多久（正常收尾：布局 0.8 秒 ×2 + 终端 3.5 秒 + 主线程看门狗 5 秒以内）。 */
export const CLOSING_MAX_MS = 20_000;
/** 看门狗写 instance.json 的间隔。 */
export const INSTANCE_WRITE_MS = 10_000;
/** 再双击时，上一份最后一次心跳超过这么久就算卡死。 */
export const STALE_INSTANCE_MS = 30_000;
/**
 * 发现上一份像是卡死后，再等这么久重读一次：电脑睡眠刚醒时心跳时间也是旧的，
 * 醒来后主线程 2 秒内发心跳、看门狗 10 秒内写盘，重读就对得上。
 */
export const STALE_RECHECK_MS = INSTANCE_WRITE_MS + WATCHDOG_BEAT_MS + 1_000;

/** instance.json：上一份 FF-pane 的进程号、启动时间、最后一次收到主线程心跳的时间。 */
export interface InstanceInfo {
  readonly pid: number;
  readonly startedAt: number;
  readonly lastBeat: number;
}

/** 读不懂（半截、旧格式、手改坏了）就当没有，走原来的路。 */
export function parseInstanceInfo(text: string): InstanceInfo | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const { pid, startedAt, lastBeat } = record;
  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    typeof startedAt !== "number" ||
    typeof lastBeat !== "number"
  ) {
    return undefined;
  }
  return { pid, startedAt, lastBeat };
}

export function isInstanceStale(
  info: InstanceInfo,
  now: number,
  staleMs: number = STALE_INSTANCE_MS,
): boolean {
  return now - info.lastBeat >= staleMs;
}

/** 弹框里说「已经多久没有响应」：不到 1 分钟说秒，否则说分钟。 */
export function describeSilence(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  return `${Math.round(seconds / 60)} 分钟`;
}

export type RendererGoneAction = "reload" | "give-up" | "none";

/**
 * 界面进程没了怎么办。正常退出不管；否则重载，一分钟内第 RENDERER_RELOAD_MAX 次起不再重载。
 * recent 是之前几次自动重载的时间。
 */
export function decideRendererGone(
  reason: string,
  recent: readonly number[],
  now: number,
): { readonly action: RendererGoneAction; readonly recent: readonly number[] } {
  if (reason === "clean-exit") {
    return { action: "none", recent };
  }
  const kept = recent.filter((at) => now - at < RENDERER_RELOAD_WINDOW_MS);
  if (kept.length >= RENDERER_RELOAD_MAX) {
    return { action: "give-up", recent: kept };
  }
  return { action: "reload", recent: [...kept, now] };
}

export interface MemorySample {
  readonly mainRssMb: number;
  readonly mainHeapUsedMb: number;
  readonly mainExternalMb: number;
  readonly mainArrayBuffersMb: number;
  /** 界面进程私有内存（MB）；拿不到时缺省。 */
  readonly rendererMb?: number;
  readonly gpuMb?: number;
  readonly terminals: number;
  readonly terminalBufferedMb: number;
}

export type MemoryWarning = { readonly kind: "main" | "renderer"; readonly mb: number };

/** 哪个进程超了警戒线；都没超时返回 undefined。主进程按 rss 算。 */
export function memoryWarningOf(sample: MemorySample): MemoryWarning | undefined {
  if (sample.mainRssMb >= MEMORY_WARN_MB) {
    return { kind: "main", mb: sample.mainRssMb };
  }
  if (sample.rendererMb !== undefined && sample.rendererMb >= MEMORY_WARN_MB) {
    return { kind: "renderer", mb: sample.rendererMb };
  }
  return undefined;
}

export function shouldWriteHeapSnapshot(sample: MemorySample, alreadyWritten: boolean): boolean {
  return !alreadyWritten && sample.mainHeapUsedMb >= HEAP_SNAPSHOT_MB;
}

/** 日志里的一行内存记录。 */
export function formatMemoryLine(sample: MemorySample): string {
  const parts = [
    `main rss=${sample.mainRssMb}MB heap=${sample.mainHeapUsedMb}MB external=${sample.mainExternalMb}MB arrayBuffers=${sample.mainArrayBuffersMb}MB`,
    `renderer=${sample.rendererMb ?? "?"}MB gpu=${sample.gpuMb ?? "?"}MB`,
    `terminals=${sample.terminals} buffered=${sample.terminalBufferedMb}MB`,
  ];
  return `[memory] ${parts.join(" | ")}`;
}

/** 本地日期的日志文件名：main-YYYY-MM-DD.log。 */
export function logFileNameFor(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `main-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.log`;
}

/** 超过保留天数的日志文件名（按文件名里的日期算，不认识的文件不动）。 */
export function staleLogFiles(
  names: readonly string[],
  now: Date,
  keepDays: number = LOG_KEEP_DAYS,
): readonly string[] {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const out: string[] = [];
  for (const name of names) {
    const match = /^main-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(name);
    if (match === null) {
      continue;
    }
    const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if ((today - day) / 86_400_000 >= keepDays) {
      out.push(name);
    }
  }
  return out;
}

/** 崩溃记录（Crashpad/reports 里的 .dmp）只留最近几份、不超过几天（T11.12）。 */
export const CRASH_REPORTS_KEEP = 5;
export const CRASH_REPORTS_KEEP_DAYS = 14;

/** 要删的崩溃记录：超过保留天数的，加上按时间排在第 keep 份之后的。不认识的文件不动。 */
export function staleCrashReports(
  entries: readonly { readonly name: string; readonly mtimeMs: number }[],
  now: number,
  keep: number = CRASH_REPORTS_KEEP,
  keepDays: number = CRASH_REPORTS_KEEP_DAYS,
): readonly string[] {
  const dumps = entries
    .filter((entry) => entry.name.toLowerCase().endsWith(".dmp"))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return dumps
    .filter((entry, index) => index >= keep || now - entry.mtimeMs >= keepDays * 86_400_000)
    .map((entry) => entry.name);
}

/** 界面没响应期间 GPU 进程用的 CPU 少于这么多秒，就当它卡死了（T11.13）。 */
export const GPU_STUCK_CPU_SECONDS = 0.5;
/** 自动结束 GPU 进程后，再等这么久界面还没缓过来才弹框。 */
export const GPU_UNSTICK_WAIT_MS = 15_000;

/** GPU 进程的进程号和启动以来用掉的 CPU 秒数。 */
export interface GpuSample {
  readonly pid: number;
  readonly cpuSeconds: number;
}

/**
 * 界面没响应 30 秒时，GPU 进程是不是卡死了（T11.13）。
 * 2026-11-13：系统内存耗尽，GPU 进程分配失败后卡在崩溃处理里睡着不退，界面同步等它，永远等不到。
 * 卡在那里的 GPU 进程一点 CPU 都不用：同一个进程、这段时间 CPU 几乎没走就判卡死。
 * 界面只是忙（GPU 闲着）也会判成卡死，结束 GPU 进程最多让界面闪一下重画，终端不受影响。
 * GPU 进程中途换了（Chromium 已经重开过）或拿不到数就不判。
 */
export function isGpuStuck(before: GpuSample | undefined, after: GpuSample | undefined): boolean {
  if (before === undefined || after === undefined || before.pid !== after.pid) {
    return false;
  }
  return after.cpuSeconds - before.cpuSeconds < GPU_STUCK_CPU_SECONDS;
}

export function toMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}
