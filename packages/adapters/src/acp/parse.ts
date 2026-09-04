/**
 * ACP 入站载荷的宽容解析（T8.5a）：wire JSON → 视图类型（types.ts）。
 *
 * 解析姿态与四家适配器映射器一致（W2.3~T7.3 的既有纪律）：
 * 1. **不抛**——缺字段 / 类型不符给出可用的降级视图或 undefined，由调用方决定
 *    进诊断通道还是拒绝；协议层解析函数抛错会把一条坏消息升级成整条连接的故障。
 * 2. **raw 恒透传**——每个视图都带 wire 原文，未建型字段随时可取，未来升格
 *    不需要改协议层。
 * 3. **未知判别值不硬编码丢弃**——session/update 的后 4 种与将来扩展统一走
 *    opaque 变体；字面量守卫（isAcpToolKind 等）供消费方收窄，本层不预判。
 */

import type {
  AcpContentBlockView,
  AcpInitializeResult,
  AcpLoadSessionResult,
  AcpNewSessionResult,
  AcpPermissionOptionView,
  AcpPermissionRequestView,
  AcpPlanEntryView,
  AcpPromptResult,
  AcpSessionNotificationView,
  AcpSessionUpdateView,
  AcpToolCallContentView,
  AcpToolCallLocationView,
  AcpToolCallView,
} from "./types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

/** 解析 initialize 响应。protocolVersion 缺失/非整数返回 undefined（握手必须严格）。 */
export function parseInitializeResult(result: unknown): AcpInitializeResult | undefined {
  if (!isObject(result)) {
    return undefined;
  }
  const version = result["protocolVersion"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return undefined;
  }
  const capabilities = result["agentCapabilities"];
  const loadSession = isObject(capabilities) && capabilities["loadSession"] === true;
  const methods = result["authMethods"];
  const authMethods = Array.isArray(methods) ? methods.filter(isObject) : [];
  return { protocolVersion: version, loadSession, authMethods, raw: result };
}

/** 解析 session/new 响应。sessionId 缺失即 undefined（没有会话 ID 什么都做不了）。 */
export function parseNewSessionResult(result: unknown): AcpNewSessionResult | undefined {
  if (!isObject(result)) {
    return undefined;
  }
  const sessionId = readString(result, "sessionId");
  return sessionId === undefined ? undefined : { sessionId, raw: result };
}

/** 解析 session/load 响应（正文全部在 raw；历史经 session/update 流回）。 */
export function parseLoadSessionResult(result: unknown): AcpLoadSessionResult {
  return { raw: isObject(result) ? result : {} };
}

/** 解析 session/prompt 响应。stopReason 缺失即 undefined（轮次结束原因是硬合同）。 */
export function parsePromptResult(result: unknown): AcpPromptResult | undefined {
  if (!isObject(result)) {
    return undefined;
  }
  const stopReason = readString(result, "stopReason");
  return stopReason === undefined ? undefined : { stopReason, raw: result };
}

/** 解析内容块：text 建型，其余保留判别值 + 原文。 */
export function parseContentBlock(value: unknown): AcpContentBlockView {
  if (!isObject(value)) {
    return { type: "unknown", raw: {} };
  }
  const type = readString(value, "type") ?? "unknown";
  const text = readString(value, "text");
  return {
    type,
    ...(type === "text" && text !== undefined ? { text } : {}),
    raw: value,
  };
}

function parseToolCallLocations(value: unknown): AcpToolCallLocationView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const locations: AcpToolCallLocationView[] = [];
  for (const entry of value) {
    if (!isObject(entry)) {
      continue;
    }
    const path = readString(entry, "path");
    if (path === undefined) {
      continue;
    }
    const line = entry["line"];
    locations.push({ path, ...(typeof line === "number" ? { line } : {}) });
  }
  return locations;
}

function parseToolCallContent(value: unknown): AcpToolCallContentView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: AcpToolCallContentView[] = [];
  for (const entry of value) {
    if (!isObject(entry)) {
      continue;
    }
    const type = readString(entry, "type") ?? "unknown";
    if (type === "content") {
      items.push({ kind: "content", content: parseContentBlock(entry["content"]), raw: entry });
      continue;
    }
    if (type === "diff") {
      const path = readString(entry, "path");
      const newText = readString(entry, "newText");
      if (path !== undefined && newText !== undefined) {
        const oldText = readString(entry, "oldText");
        items.push({
          kind: "diff",
          path,
          newText,
          ...(oldText === undefined ? {} : { oldText }),
          raw: entry,
        });
        continue;
      }
      // diff 缺必填字段：降级 opaque 保原文，不丢证据
    }
    items.push({ kind: "opaque", type, raw: entry });
  }
  return items;
}

/**
 * 解析 tool_call / tool_call_update 载荷（两者共形：update 只是除 toolCallId 外
 * 全部可缺）。toolCallId 缺失返回 undefined——没有 id 的工具调用无从追踪。
 */
export function parseToolCall(value: unknown): AcpToolCallView | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const toolCallId = readString(value, "toolCallId");
  if (toolCallId === undefined) {
    return undefined;
  }
  const title = readString(value, "title");
  const toolKind = readString(value, "kind");
  const status = readString(value, "status");
  return {
    toolCallId,
    ...(title === undefined ? {} : { title }),
    ...(toolKind === undefined ? {} : { toolKind }),
    ...(status === undefined ? {} : { status }),
    content: parseToolCallContent(value["content"]),
    locations: parseToolCallLocations(value["locations"]),
    ...(value["rawInput"] === undefined ? {} : { rawInput: value["rawInput"] }),
    ...(value["rawOutput"] === undefined ? {} : { rawOutput: value["rawOutput"] }),
    raw: value,
  };
}

function parsePlanEntries(value: unknown): AcpPlanEntryView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: AcpPlanEntryView[] = [];
  for (const entry of value) {
    if (!isObject(entry)) {
      continue;
    }
    entries.push({
      content: readString(entry, "content") ?? "",
      priority: readString(entry, "priority") ?? "medium",
      status: readString(entry, "status") ?? "pending",
      raw: entry,
    });
  }
  return entries;
}

function parseSessionUpdate(value: Record<string, unknown>): AcpSessionUpdateView {
  const sessionUpdate = readString(value, "sessionUpdate") ?? "unknown";
  if (
    sessionUpdate === "user_message_chunk" ||
    sessionUpdate === "agent_message_chunk" ||
    sessionUpdate === "agent_thought_chunk"
  ) {
    const messageId = readString(value, "messageId");
    return {
      kind: sessionUpdate,
      content: parseContentBlock(value["content"]),
      ...(messageId === undefined ? {} : { messageId }),
      raw: value,
    };
  }
  if (sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update") {
    const toolCall = parseToolCall(value);
    if (toolCall !== undefined) {
      return { kind: sessionUpdate, toolCall };
    }
    // toolCallId 缺失：降级 opaque，原文留档
    return { kind: "opaque", sessionUpdate, raw: value };
  }
  if (sessionUpdate === "plan") {
    return { kind: "plan", entries: parsePlanEntries(value["entries"]), raw: value };
  }
  // 规范后 5 种（available_commands_update / current_mode_update / config_option_update /
  // session_info_update / usage_update）与未来扩展统一透传：FF-pane 现阶段不消费，不硬编码
  return { kind: "opaque", sessionUpdate, raw: value };
}

/** 解析 session/update 通知参数。sessionId 缺失即 undefined（无从路由）。 */
export function parseSessionNotification(params: unknown): AcpSessionNotificationView | undefined {
  if (!isObject(params)) {
    return undefined;
  }
  const sessionId = readString(params, "sessionId");
  const update = params["update"];
  if (sessionId === undefined || !isObject(update)) {
    return undefined;
  }
  return { sessionId, update: parseSessionUpdate(update), raw: params };
}

function parsePermissionOptions(value: unknown): AcpPermissionOptionView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const options: AcpPermissionOptionView[] = [];
  for (const entry of value) {
    if (!isObject(entry)) {
      continue;
    }
    const optionId = readString(entry, "optionId");
    if (optionId === undefined) {
      continue;
    }
    options.push({
      optionId,
      name: readString(entry, "name") ?? optionId,
      optionKind: readString(entry, "kind") ?? "allow_once",
      raw: entry,
    });
  }
  return options;
}

/**
 * 解析 session/request_permission 请求参数。sessionId / toolCall.toolCallId /
 * 至少一个可选项三者缺一即 undefined——回执要 optionId，没有选项的权限请求
 * 无法作答，只能按 invalid params 拒绝（connection 层处理）。
 */
export function parsePermissionRequest(params: unknown): AcpPermissionRequestView | undefined {
  if (!isObject(params)) {
    return undefined;
  }
  const sessionId = readString(params, "sessionId");
  const toolCall = parseToolCall(params["toolCall"]);
  const options = parsePermissionOptions(params["options"]);
  if (sessionId === undefined || toolCall === undefined || options.length === 0) {
    return undefined;
  }
  return { sessionId, toolCall, options, raw: params };
}
