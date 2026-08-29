/**
 * `claude` headless 启动参数组装（W2.4）。
 *
 * 形态取 docs/adapters/claude-code.md §9.1 的推荐进程形态，四个参数是**不可省**的
 * 地基（§1.1 实测）：
 * - `-p`                        headless 开关；
 * - `--output-format stream-json` + `--verbose`  少一个就立即报错退出；
 * - `--input-format stream-json` 双向管道；**权限转发与优雅取消只在这个形态下存在**；
 * - `--permission-prompt-tool stdio` 把审批请求转到 stdout/stdin 控制协议。
 *
 * 提示词不作位置参数：双向 stream-json 形态下提示词经 stdin 的 user 消息下发
 *（§3），位置参数与它并存的行为未实测，不做假设。
 *
 * ## 隐藏参数漂移防御（§1.2 / §6.4，开发计划 R3）
 * `--permission-prompt-tool` 与 `--max-turns` 在 2.1.220 里已从 help 隐藏，
 * 官方可能在后续版本移除。本模块的三条防御：
 * 1. 把它们集中登记在 CLAUDE_CODE_HIDDEN_ARGS，升级 CLI 时按"传参不带值触发
 *    argument missing"的探测法逐个复验，不必翻代码找散落的字面量；
 * 2. `forwardPermissions: false` 是运行期逃生门——参数一旦失效可立刻关掉它，
 *    适配器降级为静态授权（allowedTools/permissionMode），能力声明同步转 "no"，
 *    UI 不再承诺一键审批；
 * 3. 参数失效时 CLI 会在 **stderr** 报错并以非零码退出（stdout 无任何事件），
 *    故适配器全程收集 stderr 尾部并写进 end.message，不让故障表现为无声的 crashed。
 */

import type { ModelId } from "@ff-pane/shared";

/** 默认 CLI 命令名（Windows 下由 W2.1a 做 PATH × PATHEXT 解析与 .cmd 垫片处理）。 */
export const CLAUDE_CODE_DEFAULT_COMMAND = "claude";

/** 不可省的地基参数（见文件头）。 */
export const CLAUDE_CODE_BASE_ARGS: readonly string[] = [
  "-p",
  "--output-format",
  "stream-json",
  "--input-format",
  "stream-json",
  "--verbose",
];

/** 权限转发参数（隐藏参数，值固定 stdio）。 */
export const CLAUDE_CODE_PERMISSION_PROMPT_ARGS: readonly string[] = [
  "--permission-prompt-tool",
  "stdio",
];

/** 本适配器依赖的隐藏参数清单：CLI 升级后按此表逐个复验（见文件头防御 1）。 */
export const CLAUDE_CODE_HIDDEN_ARGS: readonly string[] = [
  "--permission-prompt-tool",
  "--max-turns",
];

/** `--permission-mode` 的实测取值（不传 = default，故此处不含 default）。 */
export const CLAUDE_PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
] as const;

/** `--permission-mode` 取值。 */
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

/** `--setting-sources` 的取值（控制用户全局配置泄漏，§9.3 坑 5）。 */
export const CLAUDE_SETTING_SOURCES = ["user", "project", "local"] as const;

/** `--setting-sources` 取值。 */
export type ClaudeSettingSource = (typeof CLAUDE_SETTING_SOURCES)[number];

/**
 * CLI 侧可调参数。Profile / 任务合同（权限信封翻译）由上层填入，
 * 适配器不自作主张：默认只带地基参数 + 权限转发，其余一律缺省不传。
 */
export interface ClaudeCodeCliOptions {
  /**
   * 是否启用 stdio 权限转发，默认 true。
   * 置 false = 隐藏参数逃生门（见文件头防御 2），能力声明同步降级。
   */
  readonly forwardPermissions?: boolean;
  /**
   * 是否要 token 级增量（`--include-partial-messages`），默认 false。
   * 开启后文本只走 stream_event 增量一路（见 mapper 文件头）。
   */
  readonly includePartialMessages?: boolean;
  /** 预授权工具清单（权限信封的翻译结果，如 `Write`、`Bash(git *)`）。 */
  readonly allowedTools?: readonly string[];
  /** 禁用工具清单。 */
  readonly disallowedTools?: readonly string[];
  /** 权限模式；缺省 = CLI 默认（未授权工具走转发/自动拒绝）。 */
  readonly permissionMode?: ClaudePermissionMode;
  /** 最大 agent 轮次（隐藏参数）。 */
  readonly maxTurns?: number;
  /** 单轮花费上限（美元）。 */
  readonly maxBudgetUsd?: number;
  /** 追加系统提示（FF-pane 角色注入）。 */
  readonly appendSystemPrompt?: string;
  /** 限制加载哪些配置来源（如 ["user"]，抑制项目级配置泄漏）。 */
  readonly settingSources?: readonly ClaudeSettingSource[];
  /** 忽略其他 MCP 配置。 */
  readonly strictMcpConfig?: boolean;
  /** 逃生门：原样追加的额外参数（放在末尾）。 */
  readonly extraArgs?: readonly string[];
}

/** 本轮特有的启动参数。 */
export interface ClaudeCodeTurnArgs {
  readonly model?: ModelId | undefined;
  /** 原生会话 ID（cwd 一致性由适配器在启动前校验）。 */
  readonly resumeSessionId?: string | undefined;
}

/** 组装 `claude` 的完整参数表。 */
export function buildClaudeCodeArgs(
  options: ClaudeCodeCliOptions,
  turn: ClaudeCodeTurnArgs = {},
): readonly string[] {
  const args: string[] = [...CLAUDE_CODE_BASE_ARGS];
  if (options.forwardPermissions !== false) {
    args.push(...CLAUDE_CODE_PERMISSION_PROMPT_ARGS);
  }
  if (options.includePartialMessages === true) {
    args.push("--include-partial-messages");
  }
  if (turn.model !== undefined) {
    args.push("--model", turn.model);
  }
  if (turn.resumeSessionId !== undefined) {
    args.push("--resume", turn.resumeSessionId);
  }
  // 变参形态：`--allowedTools "Write" "Bash(git *)"`（§6.2 实测），
  // 空格与括号的转义由 W2.1a 的 Windows 垫片处理，此处只管分词。
  if (options.allowedTools !== undefined && options.allowedTools.length > 0) {
    args.push("--allowedTools", ...options.allowedTools);
  }
  if (options.disallowedTools !== undefined && options.disallowedTools.length > 0) {
    args.push("--disallowedTools", ...options.disallowedTools);
  }
  if (options.permissionMode !== undefined) {
    args.push("--permission-mode", options.permissionMode);
  }
  if (options.maxTurns !== undefined) {
    args.push("--max-turns", String(options.maxTurns));
  }
  if (options.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(options.maxBudgetUsd));
  }
  if (options.appendSystemPrompt !== undefined) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }
  if (options.settingSources !== undefined && options.settingSources.length > 0) {
    args.push("--setting-sources", options.settingSources.join(","));
  }
  if (options.strictMcpConfig === true) {
    args.push("--strict-mcp-config");
  }
  if (options.extraArgs !== undefined) {
    args.push(...options.extraArgs);
  }
  return args;
}
