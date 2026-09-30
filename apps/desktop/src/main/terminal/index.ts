/** 主进程终端模块出口（T10.1）。 */
export { createNodePtyFactory } from "./factory";
export { createTerminalLayer, type TerminalLayer } from "./handlers";
export { MAX_EXITED_SESSIONS, PtyManager, type PtyManagerOptions } from "./manager";
export { runPtyCheck } from "./pty-check";
export { ByteRingBuffer } from "./ring-buffer";
export {
  ALLOWED_SHELL_BASENAMES,
  assertTerminalCreateIpcSafe,
  assertValidCwd,
  clampTerminalDimension,
  defaultTerminalCwd,
  MAX_TERMINAL_DIMENSION,
  resolveAllowedShell,
  resolveDefaultShell,
  TerminalValidationError,
} from "./shell";
export type {
  CreateTerminalOptions,
  PtyExitEvent,
  PtyFactory,
  PtyFactoryOptions,
  PtyHandle,
  PtyManagerListeners,
  TerminalExitNotice,
  TerminalOutputBatch,
  TerminalRecord,
} from "./types";
export { DEFAULT_OUTPUT_BUFFER_BYTES, DEFAULT_OUTPUT_FLUSH_MS } from "./types";
