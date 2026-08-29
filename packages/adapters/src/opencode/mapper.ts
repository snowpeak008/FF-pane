/**
 * OpenCode SSE 事件 → 统一 AgentEvent 映射器（W2.6，W2.1b 移交要点的实现）。
 *
 * 纯逻辑模块：不碰 HTTP、不碰进程、不读时钟。输入是 `GET /event` 每条 `data:`
 * 里已 JSON.parse 的值，输出是零条或多条 AgentEvent。之所以是"有状态的纯逻辑"
 * 而非无状态函数，是因为 OpenCode 的事件语义本身跨事件：工具部件是
 * pending→running→completed 的状态机、diff 在权限事件里而结果在工具事件里、
 * 子 Agent 会话要按 parentID 并入。这些状态全部显式存在本对象内，同一串输入
 * 必然得到同一串输出（回放测试即以此为据）。
 *
 * 映射规则（依据 docs/adapters/opencode.md §3.4/§8.1 与 156 条真实录制）：
 * - **按 sessionID 过滤**：`GET /event` 是全局流。带 parentID 且父会话在集合内的
 *   `session.created` 把子会话 ID 并入集合，否则 task 子 Agent 的事件会整段丢失。
 * - **文本**：`message.part.delta`(field=text) → 增量（final:false）；
 *   `message.part.updated` 的 text/reasoning 部件出现 `time.end` → 定稿。
 *   定稿事件在已有增量时只带空 content 作收尾信号（避免重复渲染，见
 *   events/types.ts TextEvent 注释）；若该部件从未产生过增量（非流式 Provider），
 *   定稿事件带上完整文本，不丢内容。
 * - **工具**：pending/running 不发事件，**只在终态（completed/error）按 callID
 *   收敛发一条**。write/edit/patch → file_change，bash → command，其余 → raw。
 * - **diff**：completed 态不含 diff（实测），按 callID 关联此前 `permission.asked`
 *   的 `metadata.diff`；关联不到就缺席，不造假。
 * - **退出码**：bash 的 `state.metadata.exit` 是真退出码（实测）。
 * - **权限**：`permission.asked.properties.id` 即 nativeRequestId（回执凭据）。
 * - **结束**：`session.status.idle` / `session.idle` 双保险，两者收敛成一条 end；
 *   `busy` 重新武装（同一 SSE 连接会跨多轮）。
 */

import type { ModelId, PermissionRequestPayload, RuntimeId } from "@ff-pane/shared";
import type { AgentEvent, FileChangeKind, TextChannel, TokenUsage } from "../events/index.js";
import { isJsonObject, toRawEvent } from "../events/index.js";
import { normalizeOpenCodePath } from "./paths.js";

/** Runtime 注册键。 */
export const OPENCODE_RUNTIME: RuntimeId = "opencode";

/**
 * 启动噪声与无法归属到会话的全局信号，静默丢弃。**只收录确定不含 FF-pane 所需
 * 信息的类型**：未知类型一律走 raw 通道留档，宁可日志多几行也不静默丢证据。
 *
 * 两条实测注记：
 * - `file.edited` **不带 sessionID**，一个 serve 实例服务多会话时无法归属；文件
 *   修改的权威来源是工具部件的终态，不需要它。
 * - `server.heartbeat` 是 1.18.25 每 10 秒一条的保活事件，**它甚至不在
 *   `GET /doc` 的 Event schema 里**（W2.6 真机冒烟时才发现）——这正是调研 §8.2
 *   坑 2 所说"事件 schema 无版本化承诺"的实例，也是本映射器坚持"未知即 raw"的
 *   理由。同理，`OPENCODE_EXPERIMENTAL_EVENT_SYSTEM` 那套 `session.next.*` 新事件
 *   若被打开，会以 raw 出现在日志里而不会被误当成正式输出。
 */
const IGNORED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "server.connected",
  "server.heartbeat",
  "session.updated",
  "session.diff",
  "file.edited",
  "file.watcher.updated",
  "plugin.added",
  "catalog.updated",
  "reference.updated",
  "integration.updated",
  "installation.updated",
]);

/** 产出 file_change 的工具名（docs/adapters/opencode.md §8.1）。 */
const FILE_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "patch", "apply_patch"]);

/** OpenCode 拒绝权限时写进 `state.error` 的固定文案（fixture s3 实测）。 */
const PERMISSION_REJECTED_PATTERN = /rejected permission|permission denied|user rejected/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isJsonObject(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 映射器构造参数。 */
export interface OpenCodeMapperOptions {
  /** 本轮的根会话 ID（`POST /session` 的返回值或 resume 绑定）。 */
  readonly sessionId: string;
  /** 本轮工作目录，路径归一化的基准。 */
  readonly cwd: string;
}

/** 事件映射器。 */
export interface OpenCodeEventMapper {
  /** 本轮涉及的会话 ID 集合（根会话 + 已并入的子 Agent 会话）。 */
  readonly sessionIds: ReadonlySet<string>;
  /** 映射一条 SSE 事件载荷。返回空数组表示该事件不产生统一事件。 */
  map(native: unknown): readonly AgentEvent[];
  /** 迄今累计的 token / 费用统计（无任何 step-finish 时为 undefined）。 */
  usage(): TokenUsage | undefined;
  /** 是否已经产出过 end 事件。 */
  hasEnded(): boolean;
}

interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  seen: boolean;
}

/** 创建映射器。 */
export function createOpenCodeEventMapper(options: OpenCodeMapperOptions): OpenCodeEventMapper {
  const { cwd } = options;
  const sessionIds = new Set<string>([options.sessionId]);
  /** 用户消息 ID：其 text 部件是提示词回显，不能当成 Agent 输出。 */
  const userMessageIds = new Set<string>();
  /** 已产生过增量的文本部件 ID —— 决定定稿事件是否要带全文。 */
  const streamedPartIds = new Set<string>();
  /** 文本部件 ID → 通道（answer / reasoning），供 delta 判断通道。 */
  const partChannels = new Map<string, TextChannel>();
  /** 已发过终态事件的工具 callID —— 状态机收敛。 */
  const settledToolCalls = new Set<string>();
  /** callID → 权限事件里的 unified diff。 */
  const diffByCallId = new Map<string, string>();
  /** 已定稿的文本部件 ID —— 同一部件的重复 updated 不再发第二条 final。 */
  const finalizedPartIds = new Set<string>();

  const usage: UsageAccumulator = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    seen: false,
  };

  /**
   * idle 是否可以判定为"本轮结束"。
   * 初值 false：订阅 SSE 到发送提示词之间可能收到上一轮遗留的 idle，
   * 那不是本轮的结束信号。看到本会话 busy 才武装。
   */
  let idleArmed = false;
  let ended = false;
  let failureMessage: string | undefined;

  function currentUsage(): TokenUsage | undefined {
    if (!usage.seen) {
      return undefined;
    }
    return {
      ...(usage.inputTokens > 0 ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens > 0 ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.cachedInputTokens > 0 ? { cachedInputTokens: usage.cachedInputTokens } : {}),
      ...(usage.reasoningTokens > 0 ? { reasoningTokens: usage.reasoningTokens } : {}),
      ...(usage.totalTokens > 0 ? { totalTokens: usage.totalTokens } : {}),
      ...(usage.costUsd > 0 ? { costUsd: usage.costUsd } : {}),
    };
  }

  function endEvent(reason: "completed" | "failed"): AgentEvent {
    ended = true;
    const collected = currentUsage();
    return {
      kind: "end",
      reason,
      ...(collected === undefined ? {} : { usage: collected }),
      ...(failureMessage === undefined ? {} : { message: failureMessage }),
    };
  }

  function accumulateStepFinish(part: Record<string, unknown>): void {
    const tokens = asRecord(part["tokens"]);
    const cost = asNumber(part["cost"]);
    if (tokens === undefined && cost === undefined) {
      return;
    }
    usage.seen = true;
    usage.inputTokens += asNumber(tokens?.["input"]) ?? 0;
    usage.outputTokens += asNumber(tokens?.["output"]) ?? 0;
    usage.reasoningTokens += asNumber(tokens?.["reasoning"]) ?? 0;
    usage.totalTokens += asNumber(tokens?.["total"]) ?? 0;
    usage.costUsd += cost ?? 0;
    const cache = asRecord(tokens?.["cache"]);
    usage.cachedInputTokens += asNumber(cache?.["read"]) ?? 0;
  }

  function mapTextPart(part: Record<string, unknown>, channel: TextChannel): readonly AgentEvent[] {
    const partId = asString(part["id"]);
    const messageId = asString(part["messageID"]);
    if (partId !== undefined) {
      partChannels.set(partId, channel);
    }
    const time = asRecord(part["time"]);
    if (asNumber(time?.["end"]) === undefined) {
      // 未定稿的 text 部件（含创建时的空壳）不发事件，内容靠 delta 传递。
      return [];
    }
    if (partId !== undefined && finalizedPartIds.has(partId)) {
      return [];
    }
    if (partId !== undefined) {
      finalizedPartIds.add(partId);
    }
    const streamed = partId !== undefined && streamedPartIds.has(partId);
    return [
      {
        kind: "text",
        content: streamed ? "" : (asString(part["text"]) ?? ""),
        final: true,
        channel,
        ...(messageId === undefined ? {} : { messageId }),
      },
    ];
  }

  function mapToolPart(part: Record<string, unknown>): readonly AgentEvent[] {
    const state = asRecord(part["state"]);
    const status = asString(state?.["status"]);
    if (state === undefined || status === undefined) {
      return [toRawEvent(OPENCODE_RUNTIME, part, "工具部件缺 state.status")];
    }
    if (status !== "completed" && status !== "error") {
      // pending / running：状态机中间态，按 callID 收敛只在终态发事件。
      return [];
    }
    const callId = asString(part["callID"]);
    if (callId !== undefined) {
      if (settledToolCalls.has(callId)) {
        return [];
      }
      settledToolCalls.add(callId);
    }

    const tool = asString(part["tool"]) ?? "";
    const input = asRecord(state["input"]) ?? {};
    const metadata = asRecord(state["metadata"]) ?? {};
    const errorText = asString(state["error"]);
    const denied = errorText !== undefined && PERMISSION_REJECTED_PATTERN.test(errorText);

    if (tool === "bash") {
      const exitCode = asNumber(metadata["exit"]);
      const output = asString(metadata["output"]) ?? asString(state["output"]);
      return [
        {
          kind: "command",
          command: asString(input["command"]) ?? "",
          status:
            status === "error"
              ? denied
                ? "denied"
                : "failed"
              : exitCode === undefined || exitCode === 0
                ? "completed"
                : "failed",
          ...(exitCode === undefined ? {} : { exitCode }),
          ...(output === undefined ? {} : { output }),
          ...(callId === undefined ? {} : { actionId: callId }),
        },
      ];
    }

    if (FILE_TOOLS.has(tool)) {
      const rawPath =
        asString(metadata["filepath"]) ?? asString(input["filePath"]) ?? asString(input["path"]);
      const diff = callId === undefined ? undefined : diffByCallId.get(callId);
      // `metadata.exists === false` 是"此前不存在"，即新建（实测 write 工具）。
      const changeKind: FileChangeKind = metadata["exists"] === false ? "add" : "update";
      return [
        {
          kind: "file_change",
          path: rawPath === undefined ? "" : normalizeOpenCodePath(rawPath, cwd),
          changeKind,
          status: status === "error" ? (denied ? "denied" : "failed") : "completed",
          ...(diff === undefined ? {} : { diff }),
          ...(callId === undefined ? {} : { actionId: callId }),
        },
      ];
    }

    // read / glob / grep / task / webfetch / MCP 工具等：归不进六类，留档不丢证据。
    return [toRawEvent(OPENCODE_RUNTIME, part, `未归类工具部件：${tool}`)];
  }

  function mapPartUpdated(props: Record<string, unknown>): readonly AgentEvent[] {
    const part = asRecord(props["part"]);
    if (part === undefined) {
      return [toRawEvent(OPENCODE_RUNTIME, props, "message.part.updated 缺 part")];
    }
    const messageId = asString(part["messageID"]);
    if (messageId !== undefined && userMessageIds.has(messageId)) {
      // 用户消息的部件是提示词本身，不是 Agent 输出。
      return [];
    }
    switch (asString(part["type"])) {
      case "text":
        return mapTextPart(part, "answer");
      case "reasoning":
        return mapTextPart(part, "reasoning");
      case "tool":
        return mapToolPart(part);
      case "step-finish":
        accumulateStepFinish(part);
        // token/费用已入统计，事件本身留档（events/types.ts 明确点名 step_finish）。
        return [toRawEvent(OPENCODE_RUNTIME, part, "step-finish（token/费用统计）")];
      case "step-start":
        return [];
      default:
        return [toRawEvent(OPENCODE_RUNTIME, part, "未归类的 part 类型")];
    }
  }

  function mapDelta(props: Record<string, unknown>): readonly AgentEvent[] {
    if (asString(props["field"]) !== "text") {
      // 非文本字段的增量（工具入参流式拼装等）无展示价值，丢弃。
      return [];
    }
    const delta = asString(props["delta"]);
    if (delta === undefined || delta === "") {
      return [];
    }
    const partId = asString(props["partID"]);
    const messageId = asString(props["messageID"]);
    if (partId !== undefined) {
      streamedPartIds.add(partId);
    }
    return [
      {
        kind: "text",
        content: delta,
        final: false,
        channel: (partId === undefined ? undefined : partChannels.get(partId)) ?? "answer",
        ...(messageId === undefined ? {} : { messageId }),
      },
    ];
  }

  function mapPermissionAsked(props: Record<string, unknown>): readonly AgentEvent[] {
    const nativeRequestId = asString(props["id"]);
    if (nativeRequestId === undefined) {
      return [toRawEvent(OPENCODE_RUNTIME, props, "permission.asked 缺 properties.id")];
    }
    const permission = asString(props["permission"]) ?? "";
    const metadata = asRecord(props["metadata"]) ?? {};
    const patterns: readonly unknown[] = Array.isArray(props["patterns"]) ? props["patterns"] : [];
    const firstPattern = asString(patterns[0]);
    const rawPath = asString(metadata["filepath"]) ?? firstPattern;
    const path = rawPath === undefined ? "" : normalizeOpenCodePath(rawPath, cwd);
    const diff = asString(metadata["diff"]);
    const callId = asString(asRecord(props["tool"])?.["callID"]);
    if (callId !== undefined && diff !== undefined) {
      diffByCallId.set(callId, diff);
    }

    return [
      {
        kind: "permission_request",
        nativeRequestId,
        payload: buildPermissionPayload(permission, path, metadata, firstPattern),
        ...(diff === undefined ? {} : { diff }),
        toolName: permission,
      },
    ];
  }

  function mapSessionStatus(props: Record<string, unknown>): readonly AgentEvent[] {
    const status = asString(asRecord(props["status"])?.["type"]);
    if (status === "busy") {
      idleArmed = true;
      return [];
    }
    if (status !== "idle") {
      return [];
    }
    return mapIdle();
  }

  function mapIdle(): readonly AgentEvent[] {
    if (!idleArmed || ended) {
      return [];
    }
    // idle 与 session.idle 是同一事实的双保险，收敛成一条 end。
    idleArmed = false;
    return [endEvent(failureMessage === undefined ? "completed" : "failed")];
  }

  function mapMessageUpdated(props: Record<string, unknown>): readonly AgentEvent[] {
    const info = asRecord(props["info"]);
    if (info === undefined) {
      return [];
    }
    const id = asString(info["id"]);
    if (id !== undefined && asString(info["role"]) === "user") {
      userMessageIds.add(id);
    }
    const error = asRecord(info["error"]);
    if (error === undefined) {
      return [];
    }
    // 消息级错误不是终止信号（随后仍会有 idle），先记下原因供 end 使用。
    failureMessage = describeError(error);
    return [toRawEvent(OPENCODE_RUNTIME, info, "assistant 消息携带 error")];
  }

  function mapSessionError(props: Record<string, unknown>): readonly AgentEvent[] {
    failureMessage = describeError(asRecord(props["error"]) ?? props);
    if (ended) {
      return [];
    }
    // docs/adapters/opencode.md §8.1：session.error 即失败终局。
    return [endEvent("failed")];
  }

  return {
    sessionIds,
    hasEnded: (): boolean => ended,
    usage: currentUsage,
    map(native: unknown): readonly AgentEvent[] {
      const event = asRecord(native);
      if (event === undefined) {
        return [toRawEvent(OPENCODE_RUNTIME, native, "SSE 事件载荷不是 JSON 对象")];
      }
      const type = asString(event["type"]);
      if (type === undefined) {
        return [toRawEvent(OPENCODE_RUNTIME, event, "SSE 事件缺 type 字段")];
      }
      const props = asRecord(event["properties"]) ?? {};

      // session.created 必须先于 sessionID 过滤处理：子 Agent 会话的 ID 尚未入集合。
      if (type === "session.created") {
        const info = asRecord(props["info"]);
        const id = asString(info?.["id"]);
        const parentId = asString(info?.["parentID"]);
        if (id !== undefined && parentId !== undefined && sessionIds.has(parentId)) {
          sessionIds.add(id);
        }
        return [];
      }

      const sessionId = asString(props["sessionID"]);
      if (sessionId !== undefined && !sessionIds.has(sessionId)) {
        // 全局事件流里别的会话的事件，与本轮无关。
        return [];
      }
      if (IGNORED_EVENT_TYPES.has(type)) {
        return [];
      }

      switch (type) {
        case "message.updated":
          return mapMessageUpdated(props);
        case "message.part.updated":
          return mapPartUpdated(props);
        case "message.part.delta":
          return mapDelta(props);
        case "permission.asked":
          return mapPermissionAsked(props);
        case "permission.replied":
          // 传整条事件而非 properties：raw 日志要能看出 nativeType。
          return [toRawEvent(OPENCODE_RUNTIME, event, "权限回执回声")];
        case "session.status":
          return mapSessionStatus(props);
        case "session.idle":
          return mapIdle();
        case "session.error":
          return mapSessionError(props);
        default:
          return [toRawEvent(OPENCODE_RUNTIME, event, "未归类的 OpenCode 事件类型")];
      }
    },
  };
}

/**
 * OpenCode 的权限名 → FF-pane 权限信封 5 类。
 *
 * `permission` 在 OpenAPI 里是开放 string（实测 1.18.25 的 `/doc`），MCP 工具会
 * 带来任意新名字，故必须有兜底分支。兜底选择 shell_command 而不是编造一个
 * dangerous_operation：DangerousOperation 是设计文档 §7 钉死的 6 项固定清单，
 * 往里塞不属于它的东西会污染事实；而"未知能力请求"至少与"要求执行某个动作"
 * 同类，落 shell_command 能让用户看到审批弹窗（真实权限名保留在 toolName 里），
 * 既不静默放行也不让本轮卡死在无人应答的请求上。
 */
function buildPermissionPayload(
  permission: string,
  path: string,
  metadata: Record<string, unknown>,
  fallbackPattern: string | undefined,
): PermissionRequestPayload {
  switch (permission) {
    case "edit":
    case "write":
    case "patch":
    case "apply_patch":
      return { kind: "write_path", path };
    case "read":
      return { kind: "read_path", path };
    case "bash": {
      const command = asString(metadata["command"]) ?? fallbackPattern ?? "";
      return { kind: "shell_command", command };
    }
    case "webfetch":
    case "fetch": {
      const target = asString(metadata["url"]) ?? fallbackPattern;
      return { kind: "network", ...(target === undefined ? {} : { target }) };
    }
    default: {
      const command = asString(metadata["command"]) ?? fallbackPattern ?? permission;
      return { kind: "shell_command", command };
    }
  }
}

/** 从 OpenCode 的错误结构里取人读文案（`{name, data:{message}}`，实测 fixture s7）。 */
function describeError(error: Record<string, unknown>): string {
  const data = asRecord(error["data"]);
  const message = asString(data?.["message"]) ?? asString(error["message"]);
  const name = asString(error["name"]);
  if (message === undefined) {
    return name ?? JSON.stringify(error);
  }
  return name === undefined ? message : `${name}: ${message}`;
}

/** OpenCode 的 `provider/model` 形态模型引用。 */
export interface OpenCodeModelRef {
  readonly providerID: string;
  readonly modelID: string;
}

/**
 * 解析 FF-pane 的 ModelId → OpenCode 的 `{providerID, modelID}`。
 *
 * OpenCode 一律用 `<providerID>/<modelID>` 引用模型（`-m` 参数与 HTTP body 同源），
 * 而 FF-pane 的 ModelId 是 Provider 侧的裸模型名（如 `deepseek-chat`）。
 * 故：含 `/` 时按第一个 `/` 切分；不含 `/` 时必须由 Profile 侧给出 providerID，
 * 给不出就返回 undefined（调用方退回 OpenCode 自身的默认模型，而不是瞎猜一个）。
 */
export function parseOpenCodeModel(
  model: ModelId | undefined,
  defaultProviderId: string | undefined,
): OpenCodeModelRef | undefined {
  if (model === undefined || model === "") {
    return undefined;
  }
  const slash = model.indexOf("/");
  if (slash > 0) {
    return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
  }
  if (defaultProviderId === undefined || defaultProviderId === "") {
    return undefined;
  }
  return { providerID: defaultProviderId, modelID: model };
}
