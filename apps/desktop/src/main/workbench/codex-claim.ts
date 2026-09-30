/**
 * Codex 工作台会话认领：只读扫描 CODEX_HOME/sessions 下 rollout-*.jsonl，
 * 按 cwd + 启动时间窗口认领最早匹配且未被占用的 session id。
 *
 * 性能红线：本机 sessions 可达数百文件 / 数 GB；禁止整文件 readFileSync。
 * 只读首行有限字节，并按日期目录 + mtime 窗口收窄扫描面。
 *
 * 日期目录：Codex 按**本地**日历建 YYYY/MM/DD；payload.timestamp 为 UTC。
 * 扫描同时覆盖启动/当前时刻的本地日与 UTC 日及其前后各一天。
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, resolve, sep } from "node:path";
import process from "node:process";

export interface CodexSessionMeta {
  readonly id: string;
  readonly cwd: string;
  /** ISO 或可解析时间；缺省用文件 mtime。 */
  readonly timestampMs: number;
  readonly filePath: string;
}

export interface CodexClaimRequest {
  readonly windowId: string;
  readonly cwd: string;
  readonly startedAtMs: number;
}

export interface DayParts {
  readonly y: number;
  readonly m: number;
  readonly d: number;
}

export interface CodexClaimerOptions {
  /** 可注入：默认 `$CODEX_HOME` 或 `~/.codex`。 */
  readonly codexHome?: string;
  readonly now?: () => number;
  /** 轮询间隔 ms，默认 500。 */
  readonly intervalMs?: number;
  /** 最长认领等待 ms，默认 120_000（Codex 常在首条消息后才落盘）。 */
  readonly timeoutMs?: number;
  /** 首行读取上限（字节），默认 64KiB。 */
  readonly firstLineMaxBytes?: number;
  /** 可注入本地日历拆分（单测模拟 TZ 偏移）。 */
  readonly localDayParts?: (atMs: number) => DayParts;
  readonly utcDayParts?: (atMs: number) => DayParts;
  readonly readdir?: (dir: string) => readonly string[];
  readonly readFirstLine?: (path: string, maxBytes: number) => string | undefined;
  readonly statMtimeMs?: (path: string) => number;
  /** 可注入日志（默认 console.warn）；tick 吞异常时记录。 */
  readonly logWarn?: (message: string) => void;
}

/** 首行读取默认上限。 */
export const CODEX_ROLLOUT_FIRST_LINE_MAX_BYTES = 64 * 1024;

/** 是否处于自动化测试（仅认明确测试标记；不含生产可用的 FF_PANE_DATA_ROOT）。 */
export function isAutomatedTestEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env["VITEST"] !== undefined && env["VITEST"] !== "") {
    return true;
  }
  return env["FF_PANE_E2E"] === "1";
}

/** 解析 CODEX_HOME（环境变量优先，否则 ~/.codex）。 */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env["CODEX_HOME"]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  return join(homedir(), ".codex");
}

/**
 * 判断路径是否落在用户真实 `~/.codex`（或其子路径）。
 * 用于测试隔离守卫。
 */
export function isRealUserCodexPath(candidate: string): boolean {
  const real = normalizeWorkbenchCwd(join(homedir(), ".codex"));
  const pathNorm = normalizeWorkbenchCwd(candidate);
  return (
    pathNorm === real || pathNorm.startsWith(`${real}${sep}`) || pathNorm.startsWith(`${real}/`)
  );
}

/**
 * 测试环境下若 CODEX_HOME 解析到真实用户 ~/.codex 则抛错。
 * 生产环境无操作。
 */
export function assertTestCodexHomeIsolated(
  codexHome: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isAutomatedTestEnv(env)) {
    return;
  }
  if (isRealUserCodexPath(codexHome) || isRealUserCodexPath(join(codexHome, "sessions"))) {
    throw new Error(
      `test isolation violated: CODEX_HOME resolves under real user ~/.codex (${codexHome})`,
    );
  }
}

/** 路径规范化：绝对化、去尾部分隔符、Windows 大小写不敏感比较用。 */
export function normalizeWorkbenchCwd(cwd: string): string {
  let resolved = normalize(resolve(cwd.trim()));
  if (resolved.length > 1 && (resolved.endsWith("\\") || resolved.endsWith("/"))) {
    resolved = resolved.slice(0, -1);
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function cwdEquals(a: string, b: string): boolean {
  return normalizeWorkbenchCwd(a) === normalizeWorkbenchCwd(b);
}

/**
 * 只读文件开头，截到首行（或 maxBytes）。大 jsonl 不会整文件入内存。
 */
export function readFileFirstLine(
  filePath: string,
  maxBytes = CODEX_ROLLOUT_FIRST_LINE_MAX_BYTES,
): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.alloc(Math.max(1, maxBytes));
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n <= 0) {
      return undefined;
    }
    const text = buf.subarray(0, n).toString("utf8");
    const nl = text.indexOf("\n");
    return (nl === -1 ? text : text.slice(0, nl)).replace(/\r$/, "");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 解析 rollout jsonl 首行 session_meta。损坏 / 非 meta → undefined。
 */
export function parseCodexRolloutSessionMeta(
  filePath: string,
  firstLineOrContent: string,
  fallbackMtimeMs: number,
): CodexSessionMeta | undefined {
  const firstLine =
    firstLineOrContent.includes("\n") || firstLineOrContent.includes("\r")
      ? (firstLineOrContent.split(/\r?\n/, 1)[0]?.trim() ?? "")
      : firstLineOrContent.trim();
  if (firstLine === "") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  const row = parsed as Record<string, unknown>;
  if (row["type"] !== "session_meta") {
    return undefined;
  }
  const payload = row["payload"];
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const body = payload as Record<string, unknown>;
  const idRaw = body["id"] ?? body["session_id"];
  const cwdRaw = body["cwd"];
  if (typeof idRaw !== "string" || idRaw.trim() === "") {
    return undefined;
  }
  if (typeof cwdRaw !== "string" || cwdRaw.trim() === "") {
    return undefined;
  }
  let timestampMs = fallbackMtimeMs;
  const ts = body["timestamp"];
  if (typeof ts === "string" && ts.trim() !== "") {
    const parsedTs = Date.parse(ts);
    if (!Number.isNaN(parsedTs)) {
      timestampMs = parsedTs;
    }
  } else if (typeof ts === "number" && Number.isFinite(ts)) {
    timestampMs = ts;
  }
  return {
    id: idRaw.trim(),
    cwd: cwdRaw.trim(),
    timestampMs,
    filePath,
  };
}

/** UTC 日历日拆分。 */
export function utcDayParts(atMs: number): DayParts {
  const d = new Date(atMs);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
  };
}

/** 进程本地时区日历日（Codex 建目录用本地日）。 */
export function localDayParts(atMs: number): DayParts {
  const d = new Date(atMs);
  return {
    y: d.getFullYear(),
    m: d.getMonth() + 1,
    d: d.getDate(),
  };
}

export function shiftDayParts(parts: DayParts, deltaDays: number): DayParts {
  const utc = Date.UTC(parts.y, parts.m - 1, parts.d + deltaDays);
  const d = new Date(utc);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
  };
}

export function formatDayDir(parts: DayParts): string {
  const y = parts.y.toString().padStart(4, "0");
  const m = parts.m.toString().padStart(2, "0");
  const day = parts.d.toString().padStart(2, "0");
  return `${y}/${m}/${day}`;
}

/** @deprecated 用 collectCodexSessionScanDayDirs；保留兼容旧调用。 */
export function codexSessionDayDirs(baseSessions: string, atMs: number): string {
  return join(baseSessions, ...formatDayDir(utcDayParts(atMs)).split("/"));
}

/**
 * 收集应扫描的日目录：对每个锚点时刻，纳入本地日与 UTC 日及其前后各一天（去重）。
 */
export function collectCodexSessionScanDayDirs(
  sessionsRoot: string,
  anchorsMs: readonly number[],
  options?: {
    readonly localDayParts?: (atMs: number) => DayParts;
    readonly utcDayParts?: (atMs: number) => DayParts;
  },
): string[] {
  const toLocal = options?.localDayParts ?? localDayParts;
  const toUtc = options?.utcDayParts ?? utcDayParts;
  const unique = new Set<string>();
  for (const atMs of anchorsMs) {
    for (const parts of [toLocal(atMs), toUtc(atMs)]) {
      for (const delta of [-1, 0, 1] as const) {
        unique.add(formatDayDir(shiftDayParts(parts, delta)));
      }
    }
  }
  return [...unique].map((rel) => join(sessionsRoot, ...rel.split("/")));
}

function listRolloutFilesInDirs(
  dirs: readonly string[],
  readdir: (dir: string) => readonly string[],
  isDirectory: (path: string) => boolean,
): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) {
      return;
    }
    let entries: readonly string[];
    try {
      entries = readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      if (isDirectory(full)) {
        walk(full, depth + 1);
      } else if (/^rollout-.*\.jsonl$/i.test(name)) {
        out.push(full);
      }
    }
  };
  for (const dir of dirs) {
    walk(dir, 0);
  }
  return out;
}

/**
 * 从候选 meta 中为请求挑选最早合法会话。
 * 时间窗：timestamp >= startedAtMs - 2s（时钟/落盘误差）。
 */
export function pickCodexSessionForClaim(
  request: CodexClaimRequest,
  metas: readonly CodexSessionMeta[],
  claimedIds: ReadonlySet<string>,
): CodexSessionMeta | undefined {
  const matches = metas
    .filter(
      (meta) =>
        !claimedIds.has(meta.id) &&
        cwdEquals(meta.cwd, request.cwd) &&
        meta.timestampMs >= request.startedAtMs - 2_000,
    )
    .sort((a, b) => a.timestampMs - b.timestampMs || a.filePath.localeCompare(b.filePath));
  return matches[0];
}

interface PendingClaim {
  readonly request: CodexClaimRequest;
  readonly resolve: (id: string | undefined) => void;
  readonly deadline: number;
}

/**
 * 多窗口并发认领协调器：统一 tick，按启动先后贪心配对最早未占用文件。
 *
 * 残余风险：Codex 若延迟很久才写 session_meta、或同 cwd 极短时间连开却只落一个文件，
 * 后开窗口会超时；超时后不静默 --last，改走 resume 选择器。
 */
export class CodexSessionClaimer {
  private readonly claimed = new Set<string>();
  private readonly pending = new Map<string, PendingClaim>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly options: CodexClaimerOptions & {
    readonly intervalMs: number;
    readonly timeoutMs: number;
    readonly firstLineMaxBytes: number;
  };

  constructor(options: CodexClaimerOptions = {}) {
    this.options = {
      intervalMs: options.intervalMs ?? 500,
      timeoutMs: options.timeoutMs ?? 120_000,
      firstLineMaxBytes: options.firstLineMaxBytes ?? CODEX_ROLLOUT_FIRST_LINE_MAX_BYTES,
      ...options,
    };
  }

  get claimedIds(): ReadonlySet<string> {
    return this.claimed;
  }

  reserve(sessionId: string): void {
    this.claimed.add(sessionId);
  }

  release(sessionId: string): void {
    this.claimed.delete(sessionId);
  }

  cancel(windowId: string): void {
    const entry = this.pending.get(windowId);
    if (entry === undefined) {
      return;
    }
    this.pending.delete(windowId);
    entry.resolve(undefined);
    this.ensureTimer();
  }

  start(request: CodexClaimRequest): Promise<string | undefined> {
    this.cancel(request.windowId);
    const now = this.options.now?.() ?? Date.now();
    return new Promise((resolvePromise) => {
      this.pending.set(request.windowId, {
        request,
        resolve: resolvePromise,
        deadline: now + this.options.timeoutMs,
      });
      this.ensureTimer();
      this.tick();
    });
  }

  /** 单次扫描并贪心配对（单测可直接调）。 */
  tick(): void {
    try {
      this.tickUnsafe();
    } catch (thrown) {
      // 扫描失败不得拖垮主进程；记录后下一轮再试（不含会话正文等敏感内容）
      const detail =
        thrown instanceof Error
          ? `${thrown.name}: ${thrown.message.slice(0, 200)}`
          : String(thrown).slice(0, 200);
      const log = this.options.logWarn ?? ((message: string) => console.warn(message));
      log(`[codex-claim] tick failed: ${detail}`);
      this.ensureTimer();
    }
  }

  private tickUnsafe(): void {
    const now = this.options.now?.() ?? Date.now();
    const metas = this.scanMetas();
    const sorted = [...this.pending.values()].sort(
      (a, b) =>
        a.request.startedAtMs - b.request.startedAtMs ||
        a.request.windowId.localeCompare(b.request.windowId),
    );
    const usedFiles = new Set<string>();
    const resolved: Array<{ windowId: string; id: string | undefined }> = [];

    for (const entry of sorted) {
      if (now >= entry.deadline) {
        resolved.push({ windowId: entry.request.windowId, id: undefined });
        continue;
      }
      const available = metas.filter((m) => !usedFiles.has(m.filePath) && !this.claimed.has(m.id));
      const pick = pickCodexSessionForClaim(entry.request, available, this.claimed);
      if (pick === undefined) {
        continue;
      }
      usedFiles.add(pick.filePath);
      this.claimed.add(pick.id);
      resolved.push({ windowId: entry.request.windowId, id: pick.id });
    }

    for (const item of resolved) {
      const entry = this.pending.get(item.windowId);
      if (entry === undefined) {
        continue;
      }
      this.pending.delete(item.windowId);
      entry.resolve(item.id);
    }
    this.ensureTimer();
  }

  scanMetas(): CodexSessionMeta[] {
    const home = this.options.codexHome ?? resolveCodexHome();
    assertTestCodexHomeIsolated(home);
    const sessionsRoot = join(home, "sessions");
    const readdir =
      this.options.readdir ??
      ((dir: string) => {
        try {
          return readdirSync(dir);
        } catch {
          return [];
        }
      });
    const readFirstLine =
      this.options.readFirstLine ??
      ((p: string, maxBytes: number) => readFileFirstLine(p, maxBytes));
    const statMtimeMs =
      this.options.statMtimeMs ??
      ((p: string) => {
        try {
          return statSync(p).mtimeMs;
        } catch {
          return 0;
        }
      });
    const isDirectory = (p: string): boolean => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    };

    const now = this.options.now?.() ?? Date.now();
    let earliestStart = now;
    const hasPending = this.pending.size > 0;
    for (const entry of this.pending.values()) {
      if (entry.request.startedAtMs < earliestStart) {
        earliestStart = entry.request.startedAtMs;
      }
    }
    const mtimeFloor = hasPending ? earliestStart - 2_000 : 0;

    let files: string[];
    if (hasPending) {
      const dayDirs = collectCodexSessionScanDayDirs(sessionsRoot, [earliestStart, now], {
        ...(this.options.localDayParts !== undefined
          ? { localDayParts: this.options.localDayParts }
          : {}),
        ...(this.options.utcDayParts !== undefined
          ? { utcDayParts: this.options.utcDayParts }
          : {}),
      });
      files = listRolloutFilesInDirs(dayDirs, readdir, isDirectory);
    } else {
      // 无 pending（单测/诊断）：全树列举，但仍只读首行；仍守卫真实 ~/.codex
      files = listRolloutFilesInDirs([sessionsRoot], readdir, isDirectory);
    }
    const metas: CodexSessionMeta[] = [];
    for (const filePath of files) {
      const mtime = statMtimeMs(filePath);
      if (mtime < mtimeFloor) {
        continue;
      }
      const firstLine = readFirstLine(filePath, this.options.firstLineMaxBytes);
      if (firstLine === undefined || firstLine === "") {
        continue;
      }
      const meta = parseCodexRolloutSessionMeta(filePath, firstLine, mtime);
      if (meta !== undefined) {
        metas.push(meta);
      }
    }
    return metas;
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const windowId of [...this.pending.keys()]) {
      this.cancel(windowId);
    }
  }

  private ensureTimer(): void {
    if (this.pending.size === 0) {
      if (this.timer !== undefined) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
      return;
    }
    if (this.timer === undefined) {
      this.timer = setInterval(() => this.tick(), this.options.intervalMs);
    }
  }
}

/** 文件名中的路径分隔提示（测试辅助）。 */
export function sessionsPathHint(): string {
  return `sessions${sep}YYYY${sep}MM${sep}DD${sep}rollout-*.jsonl`;
}
