/**
 * Claude Code 双向控制协议（W2.4）：stdin 消息组装 + stdout 控制记录解析。
 *
 * 协议依据 docs/adapters/claude-code.md §3 / §5 / §6.3，全部有真机 fixture：
 * - 用户消息        fixtures/claude-code/04-permission-stdio.client-input.jsonl 第 1 行
 * - 权限批准回执    同上第 2 行（`control_response` + behavior/updatedInput）
 * - interrupt 请求  fixtures/claude-code/05-interrupt.client-input.jsonl 第 2 行
 * - interrupt 回执  fixtures/claude-code/05-interrupt.jsonl 第 17 行
 *
 * 本模块只做纯粹的形状转换（无 I/O、无状态），写入 stdin 是适配器的事。
 * 组装函数返回对象而非字符串：测试可与录制的 client-input 行直接深比对。
 */

import type { PermissionDecision } from "../adapter.js";
import { asObject, asString } from "./native.js";

/** stdin 单行消息（序列化后追加 `\n` 写入）。 */
export type ClaudeStdinMessage = Record<string, unknown>;

/** 拒绝审批时回给模型的默认说明（会进入模型上下文，故用英文与 CLI 对齐）。 */
export const CLAUDE_DENY_MESSAGE = "The user denied this tool use in FF-pane.";

/**
 * 无法表达为权限信封载荷的工具（Task / Cron* / SendMessage 等逃出工作台模型的
 * 工具，见 mapper.toPermissionPayload）时的自动拒绝说明。
 * fail-closed：既不让 CLI 悬着，也不编造一个假的权限类别去骗用户点同意。
 */
export const CLAUDE_UNMAPPED_TOOL_DENY_MESSAGE =
  "FF-pane cannot express this tool in its permission envelope, so it is denied. " +
  "Use file, shell or web tools instead.";

/** stdout 上的 `can_use_tool` 控制请求（§6.3 实测形态）。 */
export interface ClaudeCanUseToolRequest {
  /** 回执凭据：control_response 必须回同一个 request_id。 */
  readonly requestId: string;
  readonly toolName: string;
  /** 待批工具的入参原样（allow 时作为 updatedInput 回写）。 */
  readonly input: Record<string, unknown>;
  /** CLI 给的人类可读说明（如 "p.txt"）。 */
  readonly description?: string;
  /** 关联的 tool_use_id（与 assistant/tool_use 配对）。 */
  readonly toolUseId?: string;
}

/** stdout 上的控制回执（本适配器只关心 interrupt 的那一条）。 */
export interface ClaudeControlReceipt {
  readonly requestId: string;
  /** subtype === "success"；false 表示 CLI 明确回了错误。 */
  readonly ok: boolean;
}

/** 解析 `can_use_tool` 控制请求；不是该形态时返回 undefined。 */
export function parseCanUseToolRequest(
  value: Record<string, unknown>,
): ClaudeCanUseToolRequest | undefined {
  if (value["type"] !== "control_request") {
    return undefined;
  }
  const request = asObject(value["request"]);
  if (request === undefined || request["subtype"] !== "can_use_tool") {
    return undefined;
  }
  const requestId = asString(value["request_id"]);
  const toolName = asString(request["tool_name"]);
  if (requestId === undefined || toolName === undefined) {
    return undefined;
  }
  const description = asString(request["description"]);
  const toolUseId = asString(request["tool_use_id"]);
  return {
    requestId,
    toolName,
    input: asObject(request["input"]) ?? {},
    ...(description === undefined ? {} : { description }),
    ...(toolUseId === undefined ? {} : { toolUseId }),
  };
}

/** 解析控制回执；不是该形态时返回 undefined。 */
export function parseControlReceipt(
  value: Record<string, unknown>,
): ClaudeControlReceipt | undefined {
  if (value["type"] !== "control_response") {
    return undefined;
  }
  const response = asObject(value["response"]);
  const requestId = asString(response?.["request_id"]);
  if (response === undefined || requestId === undefined) {
    return undefined;
  }
  return { requestId, ok: response["subtype"] === "success" };
}

/** 组装提示词下发消息（双向 stream-json 下提示词只能经 stdin 走这条路）。 */
export function buildUserMessage(prompt: string): ClaudeStdinMessage {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
  };
}

/** 组装 interrupt 控制请求（优雅取消的第一步）。 */
export function buildInterruptRequest(requestId: string): ClaudeStdinMessage {
  return {
    type: "control_request",
    request_id: requestId,
    request: { subtype: "interrupt" },
  };
}

/**
 * 组装权限审批回执。
 *
 * allow 必须带 `updatedInput`——实测 CLI 以它作为最终执行入参，缺了它等于让
 * CLI 用空入参执行；FF-pane 不改写入参，故原样回填请求里的 input。
 */
export function buildPermissionResponse(
  requestId: string,
  decision: PermissionDecision,
  input: Record<string, unknown>,
  denyMessage: string = CLAUDE_DENY_MESSAGE,
): ClaudeStdinMessage {
  const response =
    decision === "allow"
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: denyMessage };
  return {
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  };
}

/** 序列化为 stdin 的一行（JSONL：一行一个 JSON + 换行）。 */
export function serializeStdinLine(message: ClaudeStdinMessage): string {
  return `${JSON.stringify(message)}\n`;
}
