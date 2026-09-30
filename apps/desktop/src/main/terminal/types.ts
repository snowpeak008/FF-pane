/**
 * 可注入的 PTY 工厂形状（单测用假 pty；生产用 @lydell/node-pty）。
 */

export interface PtyFactoryOptions {
  readonly file: string;
  readonly args: readonly string[];
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

/** 创建选项：metadata 留给后续角色/CLI/令牌扩展，本单不解释。 */
export interface CreateTerminalOptions {
  readonly id?: string;
  readonly cwd: string;
  readonly shell?: string;
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
}

export interface PtyManagerListeners {
  readonly onOutputBatch?: (batch: TerminalOutputBatch) => void;
  readonly onExit?: (notice: TerminalExitNotice) => void;
}

/** 默认每终端输出缓冲上限（字节）。 */
export const DEFAULT_OUTPUT_BUFFER_BYTES = 1_048_576;

/** 输出合并批量窗口（毫秒）。 */
export const DEFAULT_OUTPUT_FLUSH_MS = 12;
