/**
 * cli_login 类型 Provider 的本地模型枚举——类型定义（T9.2 ③）。
 *
 * 「本地」指 CLI 自己视角能报出的可用模型（内置目录 / 已配凭证联动的目录），
 * 不是工作台代 CLI 去问模型服务端——密钥与端点由 CLI 自管（§4.2），本模块
 * 只跑各家的非交互枚举命令并解析输出。
 *
 * 支持面（T9.2 真机调研，各家结论见 docs/adapters/*.md 的「本地模型枚举」节）：
 * - codex：`codex debug models`（JSON 目录）——支持；
 * - opencode：`opencode models`（`provider/model` 逐行）——支持；
 * - grok-build：`grok models`（纯文本清单）——支持；
 * - claude-code / gemini-cli：无枚举命令——如实声明不支持（试探未知子命令会
 *   被当 prompt/query 起真轮次，绝不可为）。
 */

import type { CliLoginRuntime } from "../auth-probe/types.js";

/** 支持本地模型枚举的 Runtime（CLI_LOGIN_RUNTIMES 的子集，权威闭合清单）。 */
export const LOCAL_MODEL_RUNTIMES = ["codex", "opencode", "grok-build"] as const;

/** 支持枚举的 Runtime 字符串联合。 */
export type LocalModelRuntime = (typeof LOCAL_MODEL_RUNTIMES)[number];

/** 运行时守卫：该 cli_login Runtime 是否支持本地模型枚举（UI 决定按钮显隐）。 */
export function supportsLocalModelListing(runtime: CliLoginRuntime): runtime is LocalModelRuntime {
  return (LOCAL_MODEL_RUNTIMES as readonly string[]).includes(runtime);
}

/** 枚举出的单个模型条目。 */
export interface LocalModelEntry {
  /** 模型 ID（该 CLI 的 `-m` 类参数可直接消费的形态，如 opencode 的 `provider/model`）。 */
  readonly id: string;
  /** 显示名（CLI 未提供时与 id 相同）。 */
  readonly displayName: string;
  /** 是否为该 CLI 的默认模型（仅 grok 的清单带此标记；其余家恒 false）。 */
  readonly isDefault: boolean;
}

/** 枚举失败的分类（UI 据此给可理解提示）。 */
export const LOCAL_MODEL_ERRORS = [
  "unsupported",
  "cli_missing",
  "timeout",
  "parse_error",
  "cli_error",
] as const;

/**
 * 枚举失败分类：
 * - unsupported  该 Runtime 无本地枚举途径（claude-code / gemini-cli，调研结论）；
 * - cli_missing  PATH 中找不到该 CLI；
 * - timeout      超时（执行器已终止进程）；
 * - parse_error  命令跑完但输出解析不出任何模型条目；
 * - cli_error    命令以非预期退出码失败。
 */
export type LocalModelError = (typeof LOCAL_MODEL_ERRORS)[number];

/** listLocalModels 的判别联合结果。 */
export type LocalModelsResult =
  | { readonly ok: true; readonly models: readonly LocalModelEntry[]; readonly detail: string }
  | { readonly ok: false; readonly error: LocalModelError; readonly detail: string };
