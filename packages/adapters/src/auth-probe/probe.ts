/**
 * cli_login 登录态探测主入口（W1.5d）。
 *
 * 消费方：W3.2a 设置页（Provider 卡片的"已登录/未登录"标签与刷新按钮）、
 * W2.1c 能力声明（Runtime 可用性预检）。
 */

import { executeWithChildProcess } from "./executor.js";
import { PROBE_RULES } from "./rules.js";
import { sanitizeOutputExcerpt } from "./sanitize.js";
import type {
  CliLoginProbeResult,
  CliLoginRuntime,
  ExecutionOutcome,
  ProbeCliLoginOptions,
} from "./types.js";

/** 默认探测超时（毫秒）。真机实测四个 CLI 暖启动均在 10s 内完成。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/**
 * 探测指定 Runtime 的 CLI 登录态。
 *
 * 只执行非交互的状态查询命令（各 Runtime 的命令与判定规则见 rules.ts），
 * 绝不触发登录流程。执行器异常一律吞掉并落为 unknown——探测失败不应
 * 阻断设置页渲染。
 */
export async function probeCliLogin(
  runtime: CliLoginRuntime,
  options: ProbeCliLoginOptions = {},
): Promise<CliLoginProbeResult> {
  const rule = PROBE_RULES[runtime];
  const execute = options.execute ?? executeWithChildProcess;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probedWith = [rule.command, ...rule.args].join(" ");

  let outcome: ExecutionOutcome;
  try {
    outcome = await execute(rule.command, [...rule.args], timeoutMs);
  } catch (error) {
    return {
      status: "unknown",
      detail: `执行器异常：${sanitizeOutputExcerpt(String(error))}`,
      probedWith,
    };
  }

  switch (outcome.kind) {
    case "cli_missing":
      return {
        status: "cli_missing",
        detail: `PATH 中未找到可执行文件 ${rule.command}`,
        probedWith,
      };
    case "timeout":
      return {
        status: "unknown",
        detail: `探测超时（>${timeoutMs}ms），无法判定登录态`,
        probedWith,
      };
    case "completed": {
      const verdict = rule.evaluate(outcome);
      return { status: verdict.status, detail: verdict.detail, probedWith };
    }
  }
}
