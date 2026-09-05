/**
 * ACP（Agent Client Protocol）会话语义类型（T8.5a）。
 *
 * 依据：官方规范 https://agentclientprotocol.com（zed-industries 发起，2025-08 发布），
 * 字面量与结构逐一对照官方 schema release **schema-v1.21.0**
 * （github.com/agentclientprotocol/agent-client-protocol，meta.json `version: 1`）。
 * 协议版本是**单个整数**（uint16，当前 `1`），只为破坏性变更递增；非破坏性演进走
 * 能力协商与 `_meta` 扩展字段——所以本文件的字面量集合是"版本 1 的规范枚举"，
 * 不是会随小版本漂移的猜测。
 *
 * 角色分工：FF-pane 是 ACP 的 **Client**（编辑器侧，spawn agent 子进程），
 * grok-build 等 CLI 是 **Agent**。本层建型只覆盖 FF-pane 用到的协议面
 * （T8.5b 只需要：initialize / authenticate / session new+load / prompt 轮次 /
 * session/update 流式通知 / 权限请求转发 / session/cancel）；用到的变体完整建型，
 * 用不到的（available_commands_update 等）以 opaque 变体**透传不硬编码**——
 * raw 原文一并保留，消费方随时可以升格。
 *
 * 入站数据的解析（宽容、不抛顶层）见 parse.ts；JSON-RPC 信封见 jsonrpc.ts。
 */

import { createLiteralGuard } from "@ff-pane/shared";

/**
 * ACP 协议版本（整数 1，schema-v1.21.0 / meta.json `version: 1`）。
 * initialize 握手时客户端报自己支持的最新版；Agent 回同版（支持时）或它的最新版，
 * 客户端不支持回来的版本就该断开（规范 Initialization 节）。
 */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * Agent 侧方法名（FF-pane 作为 Client 发起；meta.json agentMethods 的消费子集）。
 * 规范里 Agent 的基线方法是 initialize / authenticate / session/new / session/prompt，
 * session/load 需 `loadSession` 能力；session/cancel 是**通知**（无响应）。
 */
export const ACP_AGENT_METHODS = {
  initialize: "initialize",
  authenticate: "authenticate",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  // 会话模式切换（schema SetSessionModeRequest；T8.6b 起消费——iFlow 的
  // session/new 默认 currentModeId=yolo，要走权限转发必须先切 default）。
  sessionSetMode: "session/set_mode",
} as const;

/**
 * Client 侧方法名（Agent 发起、FF-pane 接收；meta.json clientMethods 的消费子集）。
 * session/update 是通知（流式进度），session/request_permission 是请求（要回执）。
 * fs/* 与 terminal/* 本产品不声明能力也不实现——Agent 无权调用，来了按未知方法回错。
 */
export const ACP_CLIENT_METHODS = {
  sessionUpdate: "session/update",
  sessionRequestPermission: "session/request_permission",
} as const;

/** 轮次结束原因（PromptResponse.stopReason，schema StopReason 全集）。 */
export const ACP_STOP_REASONS = [
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
] as const;

/** 轮次结束原因。 */
export type AcpStopReason = (typeof ACP_STOP_REASONS)[number];

/** AcpStopReason 运行时守卫。 */
export const isAcpStopReason = createLiteralGuard(ACP_STOP_REASONS);

/** 工具类目（schema ToolKind 全集；grok-build.md §2.1 已实测其中 8 个）。 */
export const ACP_TOOL_KINDS = [
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
] as const;

/** 工具类目。 */
export type AcpToolKind = (typeof ACP_TOOL_KINDS)[number];

/** AcpToolKind 运行时守卫。 */
export const isAcpToolKind = createLiteralGuard(ACP_TOOL_KINDS);

/** 工具调用状态（schema ToolCallStatus 全集）。 */
export const ACP_TOOL_CALL_STATUSES = ["pending", "in_progress", "completed", "failed"] as const;

/** 工具调用状态。 */
export type AcpToolCallStatus = (typeof ACP_TOOL_CALL_STATUSES)[number];

/** AcpToolCallStatus 运行时守卫。 */
export const isAcpToolCallStatus = createLiteralGuard(ACP_TOOL_CALL_STATUSES);

/** 权限选项类别（schema PermissionOptionKind 全集）。 */
export const ACP_PERMISSION_OPTION_KINDS = [
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
] as const;

/** 权限选项类别。 */
export type AcpPermissionOptionKind = (typeof ACP_PERMISSION_OPTION_KINDS)[number];

/** AcpPermissionOptionKind 运行时守卫。 */
export const isAcpPermissionOptionKind = createLiteralGuard(ACP_PERMISSION_OPTION_KINDS);

/** 计划条目状态（schema PlanEntryStatus 全集）。 */
export const ACP_PLAN_ENTRY_STATUSES = ["pending", "in_progress", "completed"] as const;

/** 计划条目优先级（schema PlanEntryPriority 全集）。 */
export const ACP_PLAN_ENTRY_PRIORITIES = ["high", "medium", "low"] as const;

/**
 * session/update 判别值全集（schema SessionUpdate 的 `sessionUpdate` 字段，11 个）。
 * 前 6 个完整建型（parse.ts），后 5 个以 opaque 变体透传——FF-pane 现阶段不消费，
 * 但 raw 原文保留、判别值可查（不硬编码丢弃）。
 */
export const ACP_SESSION_UPDATE_TYPES = [
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
] as const;

/** session/update 判别值。 */
export type AcpSessionUpdateType = (typeof ACP_SESSION_UPDATE_TYPES)[number];

/** AcpSessionUpdateType 运行时守卫。 */
export const isAcpSessionUpdateType = createLiteralGuard(ACP_SESSION_UPDATE_TYPES);

// ── 出站建型（FF-pane 构造并发送）─────────────────────────────────────────────

/** 实现信息（clientInfo；规范预告将来必填，现在就带上）。 */
export interface AcpImplementationInfo {
  readonly name: string;
  readonly version: string;
  /** 界面显示名（可选；缺省用 name）。 */
  readonly title?: string;
}

/**
 * Client 能力声明（initialize 请求）。FF-pane 现阶段不提供 fs / terminal 服务，
 * 缺省即规范默认（全 false）——声明了就得实现，不声明就是如实。
 */
export interface AcpClientCapabilities {
  readonly fs?: {
    readonly readTextFile?: boolean;
    readonly writeTextFile?: boolean;
  };
  readonly terminal?: boolean;
}

/** initialize 请求参数（protocolVersion 由 client.ts 恒注入，不在此重复）。 */
export interface AcpInitializeOptions {
  readonly clientInfo?: AcpImplementationInfo;
  readonly clientCapabilities?: AcpClientCapabilities;
}

/** 文本内容块（出站 prompt 用；入站解析见 AcpContentBlockView）。 */
export interface AcpTextBlock {
  readonly type: "text";
  readonly text: string;
}

/**
 * 出站内容块：文本完整建型（ACP 基线，所有 Agent 必支持），其余形态
 * （resource_link / resource / image / audio）由消费方按 Agent 的 promptCapabilities
 * 自行构造原始对象透传——本层不替它们编造类型。
 */
export type AcpOutgoingContentBlock = AcpTextBlock | Readonly<Record<string, unknown>>;

/** session/new 请求参数。cwd 必须是绝对路径（规范 Argument requirements）。 */
export interface AcpNewSessionParams {
  readonly cwd: string;
  /** 本轮注入的 MCP server 列表（形状随传输方式分叉，原样透传；缺省空数组）。 */
  readonly mcpServers?: readonly Readonly<Record<string, unknown>>[];
}

/** session/load 请求参数（需 Agent 声明 loadSession 能力）。 */
export interface AcpLoadSessionParams {
  readonly sessionId: string;
  readonly cwd: string;
  readonly mcpServers?: readonly Readonly<Record<string, unknown>>[];
}

/** session/prompt 请求参数。 */
export interface AcpPromptParams {
  readonly sessionId: string;
  readonly prompt: readonly AcpOutgoingContentBlock[];
}

/**
 * session/set_mode 请求参数（schema SetSessionModeRequest）。modeId 取自
 * session/new 响应 `modes.availableModes[].id`（Agent 自报的模式清单，本层不枚举）。
 */
export interface AcpSetModeParams {
  readonly sessionId: string;
  readonly modeId: string;
}

/** session/set_mode 响应视图（正文按 Agent 实现差异全部留在 raw）。 */
export interface AcpSetModeResult {
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * 权限请求的回执（FF-pane → Agent）。
 * cancelled：轮次已被 session/cancel 取消（规范硬性要求：cancel 后所有未决权限请求
 * **必须**以 cancelled 回执，见 schema RequestPermissionOutcome）；
 * selected：用户选了某个选项（optionId 取自请求携带的 options）。
 */
export type AcpPermissionDecision =
  | { readonly kind: "cancelled" }
  | { readonly kind: "selected"; readonly optionId: string };

// ── 入站视图（parse.ts 宽容解析的产物；raw 恒为原文透传）──────────────────────

/** initialize 响应视图。 */
export interface AcpInitializeResult {
  /** Agent 协商后的协议版本（与 ACP_PROTOCOL_VERSION 不符时 client.ts 会拒绝）。 */
  readonly protocolVersion: number;
  /** Agent 是否支持 session/load（loadSession 能力，缺省 false）。 */
  readonly loadSession: boolean;
  /** Agent 声明的认证方式（原样透传；authenticate 只需要其中的 id）。 */
  readonly authMethods: readonly Readonly<Record<string, unknown>>[];
  /** 响应原文。 */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** session/new 响应视图。 */
export interface AcpNewSessionResult {
  readonly sessionId: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** session/load 响应视图（正文按需从 raw 取；历史经 session/update 流回）。 */
export interface AcpLoadSessionResult {
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * session/prompt 响应视图。stopReason 按规范必填；未知字面量原样保留
 * （isAcpStopReason 守卫收窄），不硬编码拒绝——协议允许经能力扩展新增。
 */
export interface AcpPromptResult {
  readonly stopReason: AcpStopReason | (string & {});
  readonly raw: Readonly<Record<string, unknown>>;
}

/** 入站内容块视图：text 完整建型，其余保留判别值 + 原文。 */
export interface AcpContentBlockView {
  /** wire 判别值（"text" / "image" / "audio" / "resource" / "resource_link" / …）。 */
  readonly type: string;
  /** type === "text" 时的文本。 */
  readonly text?: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** 工具调用涉及的文件位置。 */
export interface AcpToolCallLocationView {
  readonly path: string;
  readonly line?: number;
}

/** 工具调用产出的内容：content（嵌套内容块）/ diff（文件修改全文）/ 其余透传。 */
export type AcpToolCallContentView =
  | {
      readonly kind: "content";
      readonly content: AcpContentBlockView;
      readonly raw: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "diff";
      readonly path: string;
      readonly oldText?: string;
      readonly newText: string;
      readonly raw: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "opaque";
      readonly type: string;
      readonly raw: Readonly<Record<string, unknown>>;
    };

/** tool_call / tool_call_update 共用的字段视图（update 时除 toolCallId 外全部可缺）。 */
export interface AcpToolCallView {
  readonly toolCallId: string;
  readonly title?: string;
  /** 工具类目（未知字面量原样保留，isAcpToolKind 收窄）。 */
  readonly toolKind?: string;
  /** 执行状态（同上，isAcpToolCallStatus 收窄）。 */
  readonly status?: string;
  readonly content: readonly AcpToolCallContentView[];
  readonly locations: readonly AcpToolCallLocationView[];
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** 计划条目视图。 */
export interface AcpPlanEntryView {
  readonly content: string;
  /** high / medium / low（未知字面量原样保留）。 */
  readonly priority: string;
  /** pending / in_progress / completed（未知字面量原样保留）。 */
  readonly status: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * session/update 通知的解析视图（判别字段 kind 是本层自设的——wire 的
 * `sessionUpdate` 与 opaque 变体的字符串类型无法在 TS 判别联合里共存）。
 */
export type AcpSessionUpdateView =
  | {
      readonly kind: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk";
      readonly content: AcpContentBlockView;
      /** 同一消息的 chunk 共享 messageId；变化即新消息开始。 */
      readonly messageId?: string;
      readonly raw: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: "tool_call"; readonly toolCall: AcpToolCallView }
  | { readonly kind: "tool_call_update"; readonly toolCall: AcpToolCallView }
  | {
      readonly kind: "plan";
      readonly entries: readonly AcpPlanEntryView[];
      readonly raw: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "opaque";
      /** wire 的 sessionUpdate 判别值（可能是规范后 4 种，也可能是未来扩展）。 */
      readonly sessionUpdate: string;
      readonly raw: Readonly<Record<string, unknown>>;
    };

/** session/update 通知整体视图。 */
export interface AcpSessionNotificationView {
  readonly sessionId: string;
  readonly update: AcpSessionUpdateView;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** 权限选项视图。 */
export interface AcpPermissionOptionView {
  readonly optionId: string;
  readonly name: string;
  /** allow_once / allow_always / reject_once / reject_always（未知原样保留）。 */
  readonly optionKind: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** session/request_permission 请求视图。 */
export interface AcpPermissionRequestView {
  readonly sessionId: string;
  /** 待批工具调用的明细（ToolCallUpdate 形状，toolCallId 必有）。 */
  readonly toolCall: AcpToolCallView;
  readonly options: readonly AcpPermissionOptionView[];
  readonly raw: Readonly<Record<string, unknown>>;
}
