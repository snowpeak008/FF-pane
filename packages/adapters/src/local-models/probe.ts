/**
 * 本地模型枚举主入口（T9.2 ③）。
 *
 * 消费方：Provider 编辑器 cli_login 类型的「读取本地模型」按钮（经主进程
 * providers:list-local-models 通道）。执行器异常一律吞掉并落为分类失败——
 * 枚举失败不应阻断编辑器渲染，UI 给可理解提示。
 */

import { createChildProcessExecutor } from "../auth-probe/executor.js";
import type { CliLoginRuntime, ProcessExecutor } from "../auth-probe/types.js";
import { LOCAL_MODEL_RULES } from "./rules.js";
import { type LocalModelsResult, supportsLocalModelListing } from "./types.js";

/**
 * 默认枚举超时（毫秒）。opencode 首跑可能联网拉 models.dev 目录（暖机实测 3~9 s），
 * 比登录态探测的 10 s 略宽。
 */
export const DEFAULT_LIST_MODELS_TIMEOUT_MS = 20_000;

/**
 * 枚举输出上限：codex 目录 JSON 真机约 400 KB（条目内嵌 instructions 模板），
 * auth-probe 缺省的 64 KB 会截断成不可解析——放宽到 4 MB（防御性封顶不变）。
 */
export const LIST_MODELS_MAX_STREAM_BYTES = 4 * 1024 * 1024;

/** listLocalModels 可选项。 */
export interface ListLocalModelsOptions {
  /** 注入执行器（默认为放宽读流上限的 child_process 生产实现）。 */
  readonly execute?: ProcessExecutor;
  /** 超时毫秒数，默认 DEFAULT_LIST_MODELS_TIMEOUT_MS。 */
  readonly timeoutMs?: number;
}

/**
 * 枚举指定 Runtime 的本地可用模型。
 *
 * 只执行调研核实过的非交互枚举命令（rules.ts）；不支持的 Runtime
 * （claude-code / gemini-cli）直接返回 unsupported——**绝不试探未知子命令**
 * （claude 会把它当 prompt 起交互会话、gemini 会当 query 起真轮次，调研实测）。
 */
export async function listLocalModels(
  runtime: CliLoginRuntime,
  options: ListLocalModelsOptions = {},
): Promise<LocalModelsResult> {
  if (!supportsLocalModelListing(runtime)) {
    return {
      ok: false,
      error: "unsupported",
      detail: `${runtime} 无本地模型枚举途径（T9.2 调研结论，docs/adapters/）`,
    };
  }
  const rule = LOCAL_MODEL_RULES[runtime];
  const execute = options.execute ?? createChildProcessExecutor(LIST_MODELS_MAX_STREAM_BYTES);
  const timeoutMs = options.timeoutMs ?? DEFAULT_LIST_MODELS_TIMEOUT_MS;

  let outcome: Awaited<ReturnType<ProcessExecutor>>;
  try {
    outcome = await execute(rule.command, [...rule.args], timeoutMs);
  } catch (error) {
    return { ok: false, error: "cli_error", detail: `执行器异常：${String(error)}` };
  }

  switch (outcome.kind) {
    case "cli_missing":
      return {
        ok: false,
        error: "cli_missing",
        detail: `PATH 中未找到可执行文件 ${rule.command}`,
      };
    case "timeout":
      return { ok: false, error: "timeout", detail: `枚举超时（>${timeoutMs}ms）` };
    case "completed":
      return rule.parse(outcome);
  }
}
