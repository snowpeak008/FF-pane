/**
 * 主进程 PTY 管理器（T10.1）：多终端生命周期、环形缓冲、批量输出、忙闲判断、退出清场。
 * 可注入 pty 工厂与 Job Object 圈禁，便于单测。
 *
 * 会话清理约定：
 * - kill（主动终止）：推送 exit 后从 Map 删除（含缓冲），避免重启堆积。
 * - 自然退出：保留 exited 快照供 UI/回放，但超过 MAX_EXITED_SESSIONS 时淘汰最旧。
 * - killAll：终止并清空 Map。
 */

import { randomUUID } from "node:crypto";
import process from "node:process";
import { assignProcessToNewJob, killProcessTree, type ProcessJob } from "@ff-pane/adapters";
import { ByteRingBuffer } from "./ring-buffer";
import { assertValidCwd, clampTerminalDimension, resolveAllowedShell } from "./shell";
import type {
  CreateTerminalOptions,
  PtyFactory,
  PtyHandle,
  PtyManagerListeners,
  TerminalRecord,
} from "./types";
import { DEFAULT_OUTPUT_BUFFER_BYTES, DEFAULT_OUTPUT_FLUSH_MS } from "./types";

/** 自然退出后保留的已退出会话上限（含环形缓冲）；超出淘汰最旧。 */
export const MAX_EXITED_SESSIONS = 8;

interface Session {
  readonly id: string;
  readonly handle: PtyHandle;
  readonly cwd: string;
  readonly shell: string;
  readonly createdAt: number;
  readonly buffer: ByteRingBuffer;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
  readonly job: ProcessJob | undefined;
  cols: number;
  rows: number;
  lastOutputAt: number;
  lastInputAt: number;
  exited: boolean;
  exitCode: number | undefined;
  pendingOutput: string;
}

export interface PtyManagerOptions {
  readonly factory: PtyFactory;
  readonly listeners?: PtyManagerListeners;
  readonly outputBufferBytes?: number;
  readonly outputFlushMs?: number;
  readonly maxExitedSessions?: number;
  readonly now?: () => number;
  readonly assignJob?: (pid: number) => ProcessJob | undefined;
  readonly killTree?: (pid: number) => Promise<unknown>;
}

export class PtyManager {
  private readonly sessions = new Map<string, Session>();
  private readonly factory: PtyFactory;
  private readonly listeners: PtyManagerListeners;
  private readonly outputBufferBytes: number;
  private readonly outputFlushMs: number;
  private readonly maxExitedSessions: number;
  private readonly now: () => number;
  private readonly assignJob: (pid: number) => ProcessJob | undefined;
  private readonly killTree: (pid: number) => Promise<unknown>;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(options: PtyManagerOptions) {
    this.factory = options.factory;
    this.listeners = options.listeners ?? {};
    this.outputBufferBytes = options.outputBufferBytes ?? DEFAULT_OUTPUT_BUFFER_BYTES;
    this.outputFlushMs = options.outputFlushMs ?? DEFAULT_OUTPUT_FLUSH_MS;
    this.maxExitedSessions = options.maxExitedSessions ?? MAX_EXITED_SESSIONS;
    this.now = options.now ?? (() => Date.now());
    this.assignJob = options.assignJob ?? assignProcessToNewJob;
    this.killTree =
      options.killTree ?? ((pid: number) => killProcessTree(pid).catch(() => undefined));
  }

  create(options: CreateTerminalOptions): TerminalRecord {
    this.assertAlive();
    const cwd = assertValidCwd(options.cwd);
    const shell = resolveAllowedShell(options.shell);
    const cols = clampTerminalDimension(options.cols);
    const rows = clampTerminalDimension(options.rows);
    const id = options.id?.trim() || randomUUID();
    if (this.sessions.has(id)) {
      throw new Error(`terminal id already exists: ${id}`);
    }

    const env = mergeEnv(process.env, options.env);
    const handle = this.factory({
      file: shell,
      args: options.args === undefined ? [] : [...options.args],
      cwd,
      env,
      cols,
      rows,
      name: "xterm-256color",
    });

    const createdAt = this.now();
    const job = this.assignJob(handle.pid);
    const session: Session = {
      id,
      handle,
      cwd,
      shell,
      createdAt,
      buffer: new ByteRingBuffer(this.outputBufferBytes),
      metadata: options.metadata,
      job,
      cols,
      rows,
      lastOutputAt: createdAt,
      lastInputAt: createdAt,
      exited: false,
      exitCode: undefined,
      pendingOutput: "",
    };
    this.sessions.set(id, session);

    handle.onData((data) => {
      if (session.exited) {
        return;
      }
      session.buffer.append(data);
      session.lastOutputAt = this.now();
      session.pendingOutput += data;
      this.scheduleFlush();
    });
    handle.onExit((event) => {
      // 自然退出：保留快照供 UI，受 maxExitedSessions 约束
      this.handleExit(session, event.exitCode, { remove: false });
    });

    return toRecord(session);
  }

  write(id: string, data: string): void {
    const session = this.requireSession(id);
    if (session.exited) {
      throw new Error(`terminal already exited: ${id}`);
    }
    session.lastInputAt = this.now();
    session.handle.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.requireSession(id);
    if (session.exited) {
      return;
    }
    const nextCols = clampTerminalDimension(cols);
    const nextRows = clampTerminalDimension(rows);
    session.cols = nextCols;
    session.rows = nextRows;
    session.handle.resize(nextCols, nextRows);
  }

  /** 主动终止：推送 exit 后从 Map 删除（含缓冲）。未知 id 静默。 */
  kill(id: string): void {
    const session = this.sessions.get(id);
    if (session === undefined) {
      return;
    }
    this.terminateSession(session, { remove: true });
  }

  list(): readonly TerminalRecord[] {
    return [...this.sessions.values()].map(toRecord);
  }

  /** 未退出的会话数（T10.2 上限校验）。 */
  aliveCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (!session.exited) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * 按 metadata 谓词主动终止匹配会话（项目移除清场）。
   * 返回被杀的 id 列表。
   */
  killWhere(
    predicate: (metadata: Readonly<Record<string, unknown>> | undefined) => boolean,
  ): readonly string[] {
    const killed: string[] = [];
    for (const session of [...this.sessions.values()]) {
      if (predicate(session.metadata)) {
        this.kill(session.id);
        killed.push(session.id);
      }
    }
    return killed;
  }

  get(id: string): TerminalRecord | undefined {
    const session = this.sessions.get(id);
    return session === undefined ? undefined : toRecord(session);
  }

  /** 取回放缓冲。已退出但仍在 Map 内的会话可读；kill 删除后抛 unknown。 */
  getReplayBuffer(id: string): string {
    const session = this.requireSession(id);
    this.flushSession(session);
    return session.buffer.toString();
  }

  isIdle(id: string, quietMs: number): boolean {
    const session = this.requireSession(id);
    if (session.exited) {
      return true;
    }
    return this.now() - session.lastOutputAt >= quietMs;
  }

  /** 杀掉全部 PTY 并清空 Map。 */
  async killAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    for (const session of sessions) {
      this.terminateSession(session, { remove: true });
    }
    this.sessions.clear();
    await Promise.resolve();
  }

  /** 当前 Map 大小（单测用）。 */
  size(): number {
    return this.sessions.size;
  }

  dispose(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flushAllPending();
    this.disposed = true;
  }

  private terminateSession(session: Session, options: { readonly remove: boolean }): void {
    if (session.exited) {
      if (options.remove) {
        this.sessions.delete(session.id);
      }
      return;
    }
    try {
      if (session.job !== undefined) {
        session.job.terminate();
      } else {
        session.handle.kill();
        void this.killTree(session.handle.pid);
      }
    } catch {
      try {
        session.handle.kill();
      } catch {
        // best-effort
      }
      void this.killTree(session.handle.pid);
    }
    // 主动 kill 时 exitCode 固定为 1（真实码可能随后到，但会话已删，忽略）
    this.handleExit(session, 1, options);
  }

  private handleExit(
    session: Session,
    exitCode: number,
    options: { readonly remove: boolean },
  ): void {
    if (session.exited) {
      if (options.remove) {
        this.sessions.delete(session.id);
      }
      return;
    }
    this.flushSession(session);
    session.exited = true;
    session.exitCode = exitCode;
    try {
      session.job?.close();
    } catch {
      // ignore
    }
    this.listeners.onExit?.({ id: session.id, exitCode });
    if (options.remove) {
      this.sessions.delete(session.id);
    } else {
      this.pruneExitedSessions();
    }
  }

  /** 已退出会话数超上限时，按 createdAt 淘汰最旧。 */
  private pruneExitedSessions(): void {
    const exited = [...this.sessions.values()]
      .filter((session) => session.exited)
      .sort((a, b) => a.createdAt - b.createdAt);
    const overflow = exited.length - this.maxExitedSessions;
    if (overflow <= 0) {
      return;
    }
    for (let i = 0; i < overflow; i += 1) {
      const victim = exited[i];
      if (victim !== undefined) {
        this.sessions.delete(victim.id);
      }
    }
  }

  private requireSession(id: string): Session {
    const session = this.sessions.get(id);
    if (session === undefined) {
      throw new Error(`unknown terminal id: ${id}`);
    }
    return session;
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error("PtyManager is disposed");
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushAllPending();
    }, this.outputFlushMs);
    if (typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
      this.flushTimer.unref();
    }
  }

  private flushAllPending(): void {
    for (const session of this.sessions.values()) {
      this.flushSession(session);
    }
  }

  private flushSession(session: Session): void {
    if (session.pendingOutput.length === 0) {
      return;
    }
    const data = session.pendingOutput;
    session.pendingOutput = "";
    this.listeners.onOutputBatch?.({ id: session.id, data });
  }
}

function toRecord(session: Session): TerminalRecord {
  return {
    id: session.id,
    pid: session.handle.pid,
    cwd: session.cwd,
    shell: session.shell,
    cols: session.cols,
    rows: session.rows,
    createdAt: session.createdAt,
    lastOutputAt: session.lastOutputAt,
    lastInputAt: session.lastInputAt,
    exited: session.exited,
    exitCode: session.exitCode,
    metadata: session.metadata,
  };
}

function mergeEnv(
  base: NodeJS.ProcessEnv,
  overlay: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  if (overlay !== undefined) {
    for (const [key, value] of Object.entries(overlay)) {
      if (value === undefined) {
        delete out[key];
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}
