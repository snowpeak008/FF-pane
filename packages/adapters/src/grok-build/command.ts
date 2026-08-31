/**
 * Grok Build 命令行组装（T7.3）。
 *
 * 参数全部取自 docs/adapters/grok-build.md §1.2，并以本机 `grok --help`（1.0.13）复核。
 * 四条不可省的默认项：
 * - `--output-format streaming-json`：xAI 原生 NDJSON 流，适配器的唯一输入
 *   （`streaming-messages-json` 是 Messages 兼容投影、含占位字段，官方自己建议要原生就用前者）；
 * - `--cwd <dir>`：Agent 工作根；
 * - `--always-approve`：**否则一轮什么都干不成**（§7.3 坑 1：默认模式下 headless
 *   无人可问审批，每个工具直接以「User cancelled」落地，而进程退出码仍是 0）。
 *   与 codex 的 bypass 同一条理由：安全由 FF-pane 权限层承担（W2.7），CLI 侧只求行为确定；
 * - `--no-auto-update`：更新检查会往 stderr 写东西并拖慢启动。
 *
 * 提示词经 **`--prompt-file`** 下发，既不用位置参数也不用 stdin：
 * - 官方明写 headless **不读管道 stdin**（codex 的做法在这里不可用）；
 * - 任务合同/交接包动辄数千字、含换行与引号，作命令行参数要同时顶着 Windows 32767
 *   字符上限与引号转义两道风险。
 * 临时文件的生命周期与落点见 adapter.ts。
 */

import type { ModelId, NativeSessionBinding, RuntimeId } from "@ff-pane/shared";

/** Runtime 注册键（adapter.ts KNOWN_RUNTIMES 之一）。 */
export const GROK_BUILD_RUNTIME: RuntimeId = "grok-build";

/** 默认可执行文件名（官方安装落地为 `~/.grok/bin/grok.exe`，原生 PE，非垫片）。 */
export const DEFAULT_GROK_COMMAND = "grok";

/**
 * 权限模式。`always-approve` 是本产品默认（编译为 `--always-approve`），
 * 其余取值原样透传 `--permission-mode`，供用户显式选择时使用。
 */
export const GROK_PERMISSION_MODES = [
  "always-approve",
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "plan",
] as const;

/** 权限模式。 */
export type GrokPermissionMode = (typeof GROK_PERMISSION_MODES)[number];

/** 默认权限模式（论证见模块头）。 */
export const DEFAULT_GROK_PERMISSION_MODE: GrokPermissionMode = "always-approve";

/** buildGrokArgs 的输入。 */
export interface GrokArgsInput {
  /** 提示词临时文件的绝对路径（`--prompt-file`）。 */
  readonly promptFile: string;
  /** Agent 工作根（`--cwd`）。 */
  readonly cwd: string;
  /** 指定模型（`-m`）；缺席用 Runtime/Profile 默认。 */
  readonly model?: ModelId | undefined;
  /** 原生会话绑定；缺席 = 开新会话。 */
  readonly resume?: NativeSessionBinding | undefined;
  /** 权限模式，默认 DEFAULT_GROK_PERMISSION_MODE。 */
  readonly permissionMode?: GrokPermissionMode | undefined;
  /**
   * 是否禁止派生子 Agent，默认 **true**。
   * 依据 §7.3 坑 4：子 Agent 的工具调用不进本轮事件流，它写的文件不会产生
   * file_change 事件——开着它，Run 的变更证据就会有一段看不见的缺口。
   */
  readonly noSubagents?: boolean | undefined;
  /** 是否关闭联网搜索与抓取（对应任务信封的 network 位）。 */
  readonly disableWebSearch?: boolean | undefined;
  /** `--allow` 规则（`ToolPrefix(glob)` 语法）。 */
  readonly allowRules?: readonly string[] | undefined;
  /** `--deny` 规则；deny 优先于 allow。纵深防御，非唯一防线（§7.3 坑 2）。 */
  readonly denyRules?: readonly string[] | undefined;
  /** `--tools` 工具白名单（内部工具 ID，如 `run_terminal_command`）。 */
  readonly tools?: readonly string[] | undefined;
  /** `--disallowed-tools` 工具黑名单。 */
  readonly disallowedTools?: readonly string[] | undefined;
  /** `--max-turns` 最大 Agent 轮数（成本护栏）。 */
  readonly maxTurns?: number | undefined;
  /** `--reasoning-effort` 推理强度。 */
  readonly reasoningEffort?: string | undefined;
  /** 原样追加的参数（逃生门）。 */
  readonly extraArgs?: readonly string[] | undefined;
}

/** 权限模式 → 参数。`always-approve` 有专用标志，其余走 `--permission-mode`。 */
function permissionArgs(mode: GrokPermissionMode): string[] {
  return mode === "always-approve" ? ["--always-approve"] : ["--permission-mode", mode];
}

/**
 * 组装 grok headless 参数表（不含可执行文件本身）。
 * 纯函数，参数顺序稳定，便于单测与日志比对。
 */
export function buildGrokArgs(input: GrokArgsInput): string[] {
  const args: string[] = [
    "--prompt-file",
    input.promptFile,
    "--output-format",
    "streaming-json",
    "--cwd",
    input.cwd,
    "--no-auto-update",
  ];

  args.push(...permissionArgs(input.permissionMode ?? DEFAULT_GROK_PERMISSION_MODE));
  if (input.noSubagents ?? true) {
    args.push("--no-subagents");
  }
  if (input.disableWebSearch === true) {
    args.push("--disable-web-search");
  }
  if (input.model !== undefined && input.model !== "") {
    args.push("-m", input.model);
  }
  if (input.resume !== undefined) {
    args.push("-r", input.resume.nativeSessionId);
  }
  if (input.reasoningEffort !== undefined && input.reasoningEffort !== "") {
    args.push("--reasoning-effort", input.reasoningEffort);
  }
  if (input.maxTurns !== undefined && input.maxTurns > 0) {
    args.push("--max-turns", String(input.maxTurns));
  }
  for (const rule of input.allowRules ?? []) {
    args.push("--allow", rule);
  }
  for (const rule of input.denyRules ?? []) {
    args.push("--deny", rule);
  }
  if (input.tools !== undefined && input.tools.length > 0) {
    args.push("--tools", input.tools.join(","));
  }
  if (input.disallowedTools !== undefined && input.disallowedTools.length > 0) {
    args.push("--disallowed-tools", input.disallowedTools.join(","));
  }
  args.push(...(input.extraArgs ?? []));
  return args;
}
