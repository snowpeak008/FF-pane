/**
 * generic-exec 配置的校验与渲染（W2.2）。
 *
 * 校验返回判别联合而非抛错：设置页（W3.2）要一次拿到全部违规做行内提示；
 * 装配期的"配置本该早已校验过"由 createGenericExecAdapter 抛
 * GenericExecConfigError 兜底。
 */

/// <reference types="node" />

import path from "node:path";
import type { GenericExecConfig, GenericExecCwdStrategy } from "./types.js";
import {
  DEFAULT_ARGV_LENGTH_LIMIT,
  DEFAULT_STDERR_CAPTURE_LIMIT,
  GENERIC_EXEC_OUTPUT_FORMATS,
  GENERIC_EXEC_TASK_DELIVERIES,
  TASK_PLACEHOLDER,
} from "./types.js";

/** 单条校验违规：field 指向配置字段（与 core 的 Profile 校验同形，供表单定位）。 */
export interface GenericExecConfigViolation {
  /** 违规字段名（如 "command"、"args"、"env.OPENAI_BASE_URL"）。 */
  readonly field: string;
  /** 拒绝原因（人类可读）。 */
  readonly reason: string;
}

/** 校验结果判别联合：ok 或全部违规的列表。 */
export type GenericExecConfigValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly GenericExecConfigViolation[] };

/** 配置非法（装配期快速失败，violations 随错误上行到 IPC / 界面层）。 */
export class GenericExecConfigError extends Error {
  override readonly name = "GenericExecConfigError";
  /** 全部违规（与 validateGenericExecConfig 返回的列表一致）。 */
  readonly violations: readonly GenericExecConfigViolation[];

  constructor(violations: readonly GenericExecConfigViolation[]) {
    const fields = violations.map((violation) => violation.field).join("、");
    super(`generic-exec 配置非法（${violations.length} 处违规）：${fields}`);
    this.violations = violations;
  }
}

/** 参数模板里出现 {task} 的次数（跨元素累计）。 */
export function countTaskPlaceholders(args: readonly string[]): number {
  let count = 0;
  for (const arg of args) {
    count += arg.split(TASK_PLACEHOLDER).length - 1;
  }
  return count;
}

/**
 * 渲染参数模板：把每个元素内的 {task} 换成任务文本。
 *
 * 防注入的全部依据就在这一个函数的形状里：
 * 1. **值替换，不是命令拼接**——替换发生在数组元素内部，任务文本无论含什么
 *    （空格、引号、`&&`、`|`、`$(…)`、换行、中文）都只能是**一个** argv 元素，
 *    不可能变成新的参数、新的命令；
 * 2. 下游 W2.1a 以 `shell: false` spawn，POSIX 下 argv 直达 execve，没有解析层；
 * 3. Windows 的 .cmd 垫片路径由 W2.1a 做 MSVCRT 引号规则 + 双层 `^` 元字符转义
 *    （windows-command.ts 有实测依据），元字符原样抵达而不被 cmd 当语法；
 * 4. command 与 env 不参与替换——不给"用任务文本换掉可执行文件"留任何缝。
 */
export function renderGenericExecArgs(args: readonly string[], task: string): string[] {
  return args.map((arg) => arg.replaceAll(TASK_PLACEHOLDER, task));
}

/**
 * 渲染后 argv 的长度估算（字符）：各元素长度 + 每元素一个分隔位。
 * 用于 argv 模式的长度预检（见 types.ts 的 DEFAULT_ARGV_LENGTH_LIMIT）。
 */
export function measureArgvLength(args: readonly string[]): number {
  return args.reduce((sum, arg) => sum + arg.length + 1, 0);
}

/** 本轮实际工作目录：turn 策略取 ctx.cwd，fixed 策略取配置的绝对路径。 */
export function resolveGenericExecCwd(config: GenericExecConfig, turnCwd: string): string {
  const strategy: GenericExecCwdStrategy = config.cwd ?? { mode: "turn" };
  return strategy.mode === "fixed" ? strategy.path : turnCwd;
}

/** argv 长度预算（缺省值 + 0 表示不限）。 */
export function resolveArgvLengthLimit(config: GenericExecConfig): number {
  return config.argvLengthLimit ?? DEFAULT_ARGV_LENGTH_LIMIT;
}

/** stderr 捕获上限（缺省值）。 */
export function resolveStderrCaptureLimit(config: GenericExecConfig): number {
  return config.stderrCaptureLimit ?? DEFAULT_STDERR_CAPTURE_LIMIT;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function validateTaskDelivery(
  config: GenericExecConfig,
  violations: GenericExecConfigViolation[],
): void {
  if (!(GENERIC_EXEC_TASK_DELIVERIES as readonly string[]).includes(config.taskDelivery)) {
    violations.push({
      field: "taskDelivery",
      reason: `投递方式非法：${String(config.taskDelivery)}（须为 argv 或 stdin）`,
    });
    return;
  }
  const placeholders = countTaskPlaceholders(config.args);
  if (config.taskDelivery === "argv" && placeholders === 0) {
    violations.push({
      field: "args",
      reason: `argv 模式的参数模板必须含至少一个 ${TASK_PLACEHOLDER} 占位符，否则任务文本无处可去`,
    });
  }
  if (config.taskDelivery === "stdin" && placeholders > 0) {
    violations.push({
      field: "args",
      reason: `stdin 模式的参数模板不应含 ${TASK_PLACEHOLDER}（任务文本走 stdin，两处投递会重复）`,
    });
  }
}

function validateCwd(config: GenericExecConfig, violations: GenericExecConfigViolation[]): void {
  const strategy = config.cwd;
  if (strategy === undefined) {
    return;
  }
  if (strategy.mode !== "turn" && strategy.mode !== "fixed") {
    violations.push({
      field: "cwd.mode",
      reason: `工作目录策略非法：${String((strategy as { mode: unknown }).mode)}`,
    });
    return;
  }
  if (strategy.mode === "fixed") {
    if (strategy.path.trim() === "") {
      violations.push({ field: "cwd.path", reason: "fixed 策略必须给出工作目录" });
    } else if (!path.isAbsolute(strategy.path)) {
      violations.push({
        field: "cwd.path",
        reason: `工作目录必须是绝对路径（相对谁解析是歧义）：${strategy.path}`,
      });
    }
  }
}

function validateEnv(config: GenericExecConfig, violations: GenericExecConfigViolation[]): void {
  for (const [name, value] of Object.entries(config.env ?? {})) {
    if (name.trim() === "" || name.includes("=")) {
      violations.push({ field: `env.${name}`, reason: "环境变量名不得为空或含 =" });
    }
    if (value.includes(TASK_PLACEHOLDER)) {
      violations.push({
        field: `env.${name}`,
        reason: `${TASK_PLACEHOLDER} 只在参数模板中替换，环境变量里会原样传给子进程`,
      });
    }
  }
}

/**
 * 校验配置。一次返回全部违规（表单场景），ok 时不含任何列表。
 * 输入已由 TypeScript 约束形状，故本函数只查"类型说不出的约束"：
 * 占位符与投递方式的配套、路径绝对性、数值域、占位符的误用位置。
 */
export function validateGenericExecConfig(config: GenericExecConfig): GenericExecConfigValidation {
  const violations: GenericExecConfigViolation[] = [];

  if (config.command.trim() === "") {
    violations.push({ field: "command", reason: "命令不得为空" });
  } else if (config.command.includes(TASK_PLACEHOLDER)) {
    violations.push({
      field: "command",
      reason: `${TASK_PLACEHOLDER} 只在参数模板中替换；命令本身不做替换（防止任务文本换掉可执行文件）`,
    });
  }

  validateTaskDelivery(config, violations);
  validateCwd(config, violations);
  validateEnv(config, violations);

  if (config.timeoutMs !== undefined && !isNonNegativeInteger(config.timeoutMs)) {
    violations.push({
      field: "timeoutMs",
      reason: `超时须为非负整数毫秒（0 表示不限时）：${String(config.timeoutMs)}`,
    });
  }
  if (config.argvLengthLimit !== undefined && !isNonNegativeInteger(config.argvLengthLimit)) {
    violations.push({
      field: "argvLengthLimit",
      reason: `argv 长度预算须为非负整数（0 表示不限）：${String(config.argvLengthLimit)}`,
    });
  }
  if (
    config.stderrCaptureLimit !== undefined &&
    (!Number.isInteger(config.stderrCaptureLimit) || config.stderrCaptureLimit < 1)
  ) {
    violations.push({
      field: "stderrCaptureLimit",
      reason: `stderr 捕获上限须为正整数：${String(config.stderrCaptureLimit)}`,
    });
  }
  if (
    config.outputFormat !== undefined &&
    !(GENERIC_EXEC_OUTPUT_FORMATS as readonly string[]).includes(config.outputFormat)
  ) {
    violations.push({
      field: "outputFormat",
      reason: `输出格式非法：${String(config.outputFormat)}（须为 text 或 jsonl）`,
    });
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
