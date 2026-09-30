/**
 * 可注入的 PTY 工厂形状（单测用假 pty；生产用 @lydell/node-pty）。
 */

export interface PtyFactoryOptions {
  readonly file: string;
  /**
   * argv 数组，或 Windows 预转义 CommandLine 字符串。
   * .cmd 垫片须传 string：@lydell/node-pty 无 windowsVerbatimArguments，
   * 与 child_process + resolveSpawnTarget 的垫片形态对齐。
   */
  readonly args: readonly string[] | string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly cols: number;
  readonly rows: number;
  readonly name: string;
}

export interface PtyExitEvent {
  readonly exitCode: number;
  readonly signal?: number;
}

export interface PtyHandle {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: PtyExitEvent) => void): void;
}

export type PtyFactory = (options: PtyFactoryOptions) => PtyHandle;

/**
 * 创建选项。
 * - shell：白名单裸名（PowerShell / cmd），供 renderer IPC。
 * - executable：主进程内部 CLI 启动名（经 resolveSpawnTarget；工作台勿用，改走 direct）。
 * - direct：已解析的 file+argv（绕开 .cmd / cmd.exe），与 executable 互斥，direct 优先。
 * args / env 仅主进程内部可用；IPC 层拒绝。
 */
export interface CreateTerminalOptions {
  readonly id?: string;
  readonly cwd: string;
  readonly shell?: string;
  /** 主进程内部：命令名，经 resolveSpawnTarget（可能走 cmd 垫片）。 */
  readonly executable?: string;
  /**
   * 主进程内部：已解析的直接启动目标（参数数组）。
   * 工作台 Claude/Codex 必须用此路径，禁止 cmd CommandLine。
   */
  readonly direct?: {
    readonly file: string;
    readonly args?: readonly string[];
    readonly label?: string;
  };
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cols: number;
  readonly rows: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TerminalRecord {
  readonly id: string;
  readonly pid: number;
  readonly cwd: string;
  readonly shell: string;
  readonly cols: number;
  readonly rows: number;
  readonly createdAt: number;
  readonly lastOutputAt: number;
  readonly lastInputAt: number;
  readonly exited: boolean;
  readonly exitCode: number | undefined;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
}

export interface TerminalOutputBatch {
  readonly id: string;
  readonly data: string;
}

export interface TerminalExitNotice {
  readonly id: string;
  readonly exitCode: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PtyManagerListeners {
  readonly onOutputBatch?: (batch: TerminalOutputBatch) => void;
  readonly onExit?: (notice: TerminalExitNotice) => void;
}

/** 默认每终端输出缓冲上限（字节）。 */
export const DEFAULT_OUTPUT_BUFFER_BYTES = 1_048_576;

/** 输出合并批量窗口（毫秒）。 */
export const DEFAULT_OUTPUT_FLUSH_MS = 12;
