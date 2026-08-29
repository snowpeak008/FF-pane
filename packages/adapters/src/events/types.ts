/**
 * 统一 AgentEvent 事件模型 + 适配器能力声明（W2.1b）。
 *
 * 六类事件骨架取自 docs/技术选型.md §4，能力清单取自 docs/项目设计计划-v1.0.md §5.1。
 * 字段设计以四份 Runtime 调研（docs/adapters/*.md §"事件流格式" + §"能力声明核对"）
 * 为下界：任何一家能给出的信息都要有落点，任何一家给不出的信息都必须允许缺席
 *（故大量字段为可选，缺席即"该 Runtime 无此信息"，不是"未填"）。
 *
 * 生产方只有事件映射器（W2.3~2.6），消费方是适配器注册表（W2.1c）与 core 层。
 */

import type {
  ModelId,
  NativeSessionBinding,
  PermissionRequestPayload,
  RunEndReason,
  RuntimeId,
} from "@ff-pane/shared";
import { createLiteralGuard } from "@ff-pane/shared";

/**
 * 事件判别值：技术选型 §4 的六类骨架 + `raw` 兜底。
 *
 * `raw` 的取舍论证：四份调研一致给出"事件词汇会漂移，未知 type 必须跳过"的结论
 *（codex.md §7.2、claude-code.md §9.3 坑 4、gemini-cli.md §8.4 坑 7、opencode.md §8.2 坑 2），
 * 而"跳过"若是静默丢弃就等于丢证据：codex 的 todo_list / item 级 error、claude 的
 * system/thinking_tokens|status|task_started 与 hook 事件、gemini 的 warning 级 error、
 * opencode 的 step_finish/plugin.added 都属于"归不进六类但有价值或需留档"的一类。
 * 让它们以 `raw` 走同一条流，Run 的 raw_log_path（设计文档 §6.4）就只需订阅一个流，
 * 映射器也不必各自再开一条旁路；代价仅是消费方多一个 case，且处理方式恒为"记日志"。
 */
export const AGENT_EVENT_KINDS = [
  "session_start",
  "text",
  "file_change",
  "command",
  "permission_request",
  "end",
  "raw",
] as const;

/** AgentEvent 的判别字段取值。 */
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

/** AgentEventKind 运行时守卫（回放持久化事件日志时校验）。 */
export const isAgentEventKind = createLiteralGuard(AGENT_EVENT_KINDS);

/**
 * 文本通道：answer 是给用户/上层看的正式输出；reasoning 是过程性思考摘要
 *（codex 的 reasoning item、claude 的 thinking 块、opencode 的 reasoning 事件）。
 * 必填而非默认 answer：思考文本若被当成正式回答落进 Run 报告就是事实污染。
 */
export const TEXT_CHANNELS = ["answer", "reasoning"] as const;

/** 文本通道。 */
export type TextChannel = (typeof TEXT_CHANNELS)[number];

/** TextChannel 运行时守卫。 */
export const isTextChannel = createLiteralGuard(TEXT_CHANNELS);

/** 文件变更类型。与 codex `file_change.changes[].kind` 同名同义，另三家由映射器推断。 */
export const FILE_CHANGE_KINDS = ["add", "update", "delete"] as const;

/** 文件变更类型。 */
export type FileChangeKind = (typeof FILE_CHANGE_KINDS)[number];

/** FileChangeKind 运行时守卫。 */
export const isFileChangeKind = createLiteralGuard(FILE_CHANGE_KINDS);

/**
 * 文件修改 / 命令执行这类"动作"的状态：
 * - started    已发起未出结果（codex item.started、opencode 工具 part 的 running 态）；
 * - completed  成功；
 * - failed     执行了但失败（命令非零退出、写文件报错）；
 * - denied     未执行，被沙箱/策略/审批拒绝。
 *
 * `denied` 单列的理由：三份调研把"被拒却报成功"列为头号坑
 *（codex.md §7.3 坑 1 的 turn.completed、claude-code.md §9.3 坑 2 的 permission_denials、
 * gemini-cli.md §8.4 坑 1 的 headless deny），core 层据此把任务转 blocked/failed，
 * 而不是把一次"什么都没做"的 Run 记成 completed。
 */
export const AGENT_ACTION_STATUSES = ["started", "completed", "failed", "denied"] as const;

/** 文件修改 / 命令执行的动作状态。 */
export type AgentActionStatus = (typeof AGENT_ACTION_STATUSES)[number];

/** AgentActionStatus 运行时守卫。 */
export const isAgentActionStatus = createLiteralGuard(AGENT_ACTION_STATUSES);

/**
 * token / 费用统计。四家口径不同（codex turn.completed.usage、claude result.usage +
 * total_cost_usd、gemini result.stats、opencode step_finish.tokens + cost），
 * 故逐项可选：取到什么填什么，缺席即该 Runtime 不报此项。
 */
export interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** 命中缓存的输入 token（codex cached_input_tokens、claude cache_read、gemini cached）。 */
  readonly cachedInputTokens?: number;
  /** 推理 token（codex reasoning_output_tokens、opencode tokens.reasoning）。 */
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
  /** 本次花费（美元）。仅 claude 与 opencode 直接给出。 */
  readonly costUsd?: number;
}

/**
 * 会话开始。
 *
 * `native` 用 shared 的 NativeSessionBinding（nativeSessionId + cwd 成对）而非裸 ID：
 * claude-code.md §4 实证 resume 严格绑定 cwd，gemini-cli.md §4 的会话按 cwd 隔离，
 * 类型层强制成对就不会出现"登记了 ID 却恢复不了"（设计文档 §10.2 规则 3）。
 * 不支持原生会话或尚未报出 ID 的 Runtime 留空。
 */
export interface SessionStartEvent {
  readonly kind: "session_start";
  /** 原生会话绑定（ID + cwd）。Runtime 不给原生会话 ID 时缺席。 */
  readonly native?: NativeSessionBinding;
  /** Runtime 自报的模型。注意 gemini init.model 是别名（"auto"），非实际模型。 */
  readonly model?: ModelId;
}

/**
 * 文本输出。**统一为追加语义**：消费方把每条 content 拼接到当前消息尾部，
 * `final` 为真表示该消息到此收尾。
 *
 * 四家风格的映射（调研 §"事件流格式"）：
 * - codex：agent_message 整条到达 → 单条 { content: 全文, final: true }；
 * - claude：`--include-partial-messages` 的 content_block_delta → final: false，
 *   块结束/message_stop → final: true（**定稿事件可携带空 content，只作收尾信号**，
 *   否则会与增量重复）；不开该参数时每条 assistant 文本块即一条 final: true；
 * - gemini：message(role=assistant, delta: true) → final: false，流无"最终完整文本"
 *   事件，映射器在 result 到达时补一条空 content 的 final；
 * - opencode：SSE message.part.delta → final: false，part.time.end 出现 → final: true。
 */
export interface TextEvent {
  readonly kind: "text";
  /** 本次追加的文本片段（可为空字符串，表示纯收尾信号）。 */
  readonly content: string;
  /** 该消息是否到此结束。 */
  readonly final: boolean;
  /** 正式输出还是思考摘要。 */
  readonly channel: TextChannel;
  /**
   * 原生消息 ID，用于区分并行/多块消息。
   * claude 的一条消息按 content block 拆成多行且共享 message.id
   *（claude-code.md §9.3 坑 1：不按此去重会重复渲染、token 翻倍）。
   */
  readonly messageId?: string;
}

/**
 * 文件修改。
 *
 * `diff` 可选是四家实况的直接结果：claude 的 tool_use_result.structuredPatch 与
 * opencode 权限事件的 metadata.diff 直接给 diff，gemini 的 tool_result.output 是
 * 统一 diff 文本，**codex 只给路径与 kind**（codex.md §2.3 / §7.3 坑 2）——
 * 后者的 diff 由适配器用 git 快照自补（W2.3），补不到就缺席，不造假空 diff。
 */
export interface FileChangeEvent {
  readonly kind: "file_change";
  /** 文件路径，原样透传 Runtime 给出的形式（四家多为绝对路径，归一化归权限层 W2.7）。 */
  readonly path: string;
  readonly changeKind: FileChangeKind;
  readonly status: AgentActionStatus;
  /** unified diff 文本。Runtime 不提供且未自补时缺席。 */
  readonly diff?: string;
  /**
   * 原生动作 ID，用于把 started 与终态配成同一行 UI
   *（codex item.id、claude tool_use_id、gemini tool_id、opencode callID）。
   */
  readonly actionId?: string;
}

/**
 * 命令执行。
 *
 * `exitCode` 可选：codex command_execution.exit_code 与 opencode
 * state.metadata.exit 是结构化退出码；claude 只有 is_error（成功隐含 0）；
 * **gemini 无任何结构化退出码**（gemini-cli.md §3.2 / §7 能力 4）。
 * 故约定：退出码取不到就缺席，成败一律由 `status` 承载——消费方判成败看 status，
 * 看 exitCode 只为展示与取证（设计文档 §6.4 的 CommandRecord 需要一个数值时，
 * 由 W2.1c/core 按各适配器的映射规则补默认值）。
 */
export interface CommandEvent {
  readonly kind: "command";
  /** 命令原文（Windows 下 codex 给的是完整 powershell.exe 调用串）。 */
  readonly command: string;
  readonly status: AgentActionStatus;
  /** 结构化退出码。Runtime 不提供时缺席。 */
  readonly exitCode?: number;
  /** 命令输出（stdout/stderr 合并文本，可能被 Runtime 截断）。 */
  readonly output?: string;
  /** 命令的工作目录（仅 gemini run_shell_command 的 dir_path 直接给出）。 */
  readonly cwd?: string;
  /** 原生动作 ID，同 FileChangeEvent.actionId。 */
  readonly actionId?: string;
}

/**
 * 权限请求（设计文档 §7 的权限扩展请求）。
 *
 * 载荷复用 shared 的 PermissionRequestPayload：完整的 PermissionRequest 还需
 * runId/taskId/requestedAt，那是 core 层的事实，适配器给不出也不该编造。
 * `nativeRequestId` 是回复审批的唯一凭据（claude control_request.request_id →
 * 回写 control_response；opencode permission.asked.properties.id →
 * POST /session/:id/permissions/:id），丢了它审批就无法回执，故必填。
 *
 * 只有 claude（stdio 控制协议）与 opencode（Server 路径）会真的发出此事件；
 * codex exec 与 gemini headless 无原生来源，由 FF-pane 权限层自产（W2.7）。
 */
export interface PermissionRequestEvent {
  readonly kind: "permission_request";
  /** 原生请求 ID —— 审批回执凭据。 */
  readonly nativeRequestId: string;
  /** 请求内容（对齐设计文档 §7 的信封 5 项）。 */
  readonly payload: PermissionRequestPayload;
  /** Agent/Runtime 给出的说明原文（claude description、opencode 无则空）。 */
  readonly reason?: string;
  /** 待批操作的 unified diff（opencode permission.asked 的 metadata.diff 直接给出）。 */
  readonly diff?: string;
  /** 原生工具名/权限名（claude tool_name、opencode permission），供 UI 展示与规则匹配。 */
  readonly toolName?: string;
}

/**
 * 会话结束。reason 直接复用 shared 的 RunEndReason（设计文档 §6.4 的四值），
 * 避免适配器层再造一套结束原因又要在 core 层翻译一次。
 *
 * 四家共同的硬约束：**流可能没有终止事件就断**（codex 强杀无 turn.completed、
 * claude 硬杀无 result、gemini/opencode 同理），故 `end` 的最终兜底信号是进程退出：
 * 主动取消 → cancelled，否则 crashed（各调研的 §"取消方式"）。
 */
export interface EndEvent {
  readonly kind: "end";
  readonly reason: RunEndReason;
  /** token/费用统计。Runtime 不报或流被截断时缺席。 */
  readonly usage?: TokenUsage;
  /** 失败原因原文（codex turn.failed.error.message、claude result.errors、gemini error.message）。 */
  readonly message?: string;
  /**
   * 进程退出码。gemini 的退出码本身是判据（41 认证失败 / 55 未信任目录 /
   * API 错误直接透传 HTTP 状态码，gemini-cli.md §2），故单列保留。
   */
  readonly exitCode?: number;
}

/**
 * 兜底事件：归不进六类的原生事件原样透传 + 来源标注（取舍论证见 AGENT_EVENT_KINDS）。
 * 也是非 JSON 行等解析异常上交的通道（配合 InvalidJsonlLine，见 ./jsonl.ts）。
 */
export interface RawEvent {
  readonly kind: "raw";
  /** 来源 Runtime 注册键（"codex" / "claude-code" / …）。 */
  readonly runtime: RuntimeId;
  /** 原生事件的顶层 type 字段；非对象或无该字段时缺席。 */
  readonly nativeType?: string;
  /** 原生事件原样（已 JSON.parse 的值，或解析失败时的原始行文本）。 */
  readonly native: unknown;
  /** 诊断说明（未归类原因 / JSON 解析错误信息）。 */
  readonly note?: string;
}

/** 统一事件：六类骨架 + raw 兜底。适配器对外只吐这一个类型。 */
export type AgentEvent =
  | SessionStartEvent
  | TextEvent
  | FileChangeEvent
  | CommandEvent
  | PermissionRequestEvent
  | EndEvent
  | RawEvent;

/**
 * 能力支持度三态。
 *
 * 布尔 vs 三态的论证：四份调研的能力核对表里"部分"是常态而非例外——
 * codex 的流式（无 token 级增量）、文件修改事件（无 diff）、取消（无优雅协议）；
 * gemini 的命令事件（无退出码）与取消；opencode 的流式与权限转发（仅 Server 路径）。
 * 用布尔只能二选一地说谎：填 true 会让 UI 承诺做不到的事（如打字机效果、
 * 一键批准），填 false 会让上层放弃本可用的能力（如 codex 的 file_change 路径）。
 * 三态 + UI 上的"部分"提示是唯一如实的选择。
 */
export const CAPABILITY_SUPPORTS = ["yes", "partial", "no"] as const;

/** 能力支持度。 */
export type CapabilitySupport = (typeof CAPABILITY_SUPPORTS)[number];

/** CapabilitySupport 运行时守卫（读入持久化的适配器声明时校验）。 */
export const isCapabilitySupport = createLiteralGuard(CAPABILITY_SUPPORTS);

/**
 * 设计文档 §5.1 的六项能力声明。每个 Runtime 适配器（W2.3~2.6）声明一份，
 * 注册表（W2.1c）汇总，UI 据此决定按钮可用性与提示文案。
 */
export interface AdapterCapabilities {
  /** 支持原生会话恢复？（codex/claude/gemini/opencode 均为 yes，但都绑定 cwd） */
  readonly nativeResume: CapabilitySupport;
  /** 支持流式输出？（codex partial：item 粒度流式但无 token 级增量） */
  readonly streaming: CapabilitySupport;
  /** 支持文件修改事件？（codex partial：有路径无 diff） */
  readonly fileChangeEvents: CapabilitySupport;
  /** 支持命令执行事件？（gemini partial：无结构化退出码） */
  readonly commandEvents: CapabilitySupport;
  /** 支持权限请求转发？（codex exec / gemini headless 为 no，须由权限层自产） */
  readonly permissionForwarding: CapabilitySupport;
  /** 支持中途取消？（partial = 只能杀进程树，无协议级优雅取消） */
  readonly gracefulCancel: CapabilitySupport;
}

/**
 * 六项能力名（设计文档 §5.1 的列举顺序），供 UI 遍历与注册表校验。
 * `satisfies` 保证此数组与 AdapterCapabilities 的键集合不脱节。
 */
export const ADAPTER_CAPABILITY_NAMES = [
  "nativeResume",
  "streaming",
  "fileChangeEvents",
  "commandEvents",
  "permissionForwarding",
  "gracefulCancel",
] as const satisfies readonly (keyof AdapterCapabilities)[];

/** 能力名。 */
export type AdapterCapabilityName = (typeof ADAPTER_CAPABILITY_NAMES)[number];
