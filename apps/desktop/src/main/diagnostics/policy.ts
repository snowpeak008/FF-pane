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

export function toMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}
