/** generic-exec（L2 通用单次命令接入）barrel（W2.2）。 */

export {
  createGenericExecAdapter,
  GENERIC_EXEC_CAPABILITIES,
} from "./adapter.js";
export {
  countTaskPlaceholders,
  GenericExecConfigError,
  type GenericExecConfigValidation,
  type GenericExecConfigViolation,
  measureArgvLength,
  renderGenericExecArgs,
  resolveArgvLengthLimit,
  resolveGenericExecCwd,
  resolveStderrCaptureLimit,
  validateGenericExecConfig,
} from "./config.js";
export {
  DEFAULT_ARGV_LENGTH_LIMIT,
  DEFAULT_STDERR_CAPTURE_LIMIT,
  END_MESSAGE_EXCERPT_LENGTH,
  GENERIC_EXEC_CWD_MODES,
  GENERIC_EXEC_OUTPUT_FORMATS,
  GENERIC_EXEC_RUNTIME,
  GENERIC_EXEC_TASK_DELIVERIES,
  type GenericExecConfig,
  type GenericExecCwdMode,
  type GenericExecCwdStrategy,
  type GenericExecOutputFormat,
  type GenericExecTaskDelivery,
  isGenericExecCwdMode,
  isGenericExecOutputFormat,
  isGenericExecTaskDelivery,
  TASK_PLACEHOLDER,
  WINDOWS_CMD_SHIM_COMMAND_LINE_LIMIT,
} from "./types.js";
