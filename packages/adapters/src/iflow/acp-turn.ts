/**
 * iFlow ACP 轮次（T8.6b）：spawn `iflow --experimental-acp` 后经 T8.5a 的
 * `createAcpConnection` 走双工通道。**一轮 = 一次 spawn**（turn 模型不变）：
 * prompt 落定（或取消/失败）即收连接、杀进程；多轮连续性靠 `session/load`
 * （loadSession 能力 + headless/ACP 共享同一份会话存储，`real-acp-load` 实证）。
 *
 * 与 grok acp-turn 的四点实质差异（其余款式同构）：
 * 1. **无降级链**：iFlow headless 没有结构化输出（调研 §3，ACP 单通道决策见
 *    adapter.ts 头注），启动失败 / 握手失败一律 end(failed) 如实收尾——不存在
 *    「握手失败换 headless 重跑」的第二条路；
 * 2. **必须 session/set_mode**：session/new 的默认 currentModeId 是 **yolo**
 *    （真机实测，fixture 第 5 行）——不切模式就是全放行，权限层被整体绕开。
 *    开轮后恒切 default（或 plan），切失败即本轮失败（fail-closed，绝不带着
 *    yolo 跑）；
 * 3. **审批拒绝自记账**（调研坑 2，本层最要紧的差异）：请求被拒后 iFlow 静默吞
 *    工具（无任何 tool_call 事件、无 failed 帧、prompt 照样 end_turn），
 *    「没干活」由 mapper.registerDenied() 在回执 deny 的当场记账——grok 那边
 *    是等 CLI 的 failed+文本改判，iFlow 等不到任何信号；
 * 4. **事件映射一手消费 ACP 视图**（无 headless 投影可逆投影），toolName/kind
 *    在 wire 顶层、diff 自带 fileDiff，见 mapper.ts。
 *
 * 认证形态（调研 §5 + 实现单实测）：openai-compatible 三件套全走 env
 * （IFLOW_API_KEY / IFLOW_BASE_URL / IFLOW_MODEL_NAME），受管 HOME 里只放一行
 * `selectedAuthType` 的静态 settings（command.ts）。未认证快速失败两道闸：
 * initialize 响应 `isAuthenticated:false` 当场收（开箱即知，比 grok 等 -32000
 * 友好）；万一它撒谎，session/new 的 -32000 兜底。**不做 authenticate 重试**：
 * 三种 authMethods 里 oauth-iflow 是浏览器流（headless 触发即假死）、iflow API
 * key 类型已过日期开关（§5.2）、openai-compatible 靠 env 静态配置无"再认证"
 * 语义——重试没有一条能走通的路。
 */

/// <reference types="node" />

import type { PermissionRequestPayload } from "@ff-pane/shared";
import type {
  AcpPermissionDecision,
  AcpPermissionOptionView,
  AcpPermissionRequestView,
  AcpSessionNotificationView,
  AcpToolCallView,
} from "../acp/index.js";
import { createAcpConnection } from "../acp/index.js";
import type { AdapterTurnContext, PermissionDecision } from "../adapter.js";
import type { AgentEvent } from "../events/index.js";
import { isJsonObject, toRawEvent } from "../events/index.js";
import type { AgentProcessHandle, AgentProcessSpec } from "../process/index.js";
import type { IFlowAcpMode } from "./command.js";
import { IFLOW_RUNTIME } from "./command.js";
import {
  commandFromIFlowTitle,
  createIFlowEventMapper,
  fileDiffOf,
  iflowSessionStart,
  iflowToolCommand,
  iflowToolFilePath,
} from "./mapper.js";

/** cancel 通知发出后等 prompt 优雅落定的宽限期，超时树杀兜底（grok 同款数值）。 */
export const IFLOW_ACP_CANCEL_GRACE_MS = 5_000;

/** initialize 握手时报的 clientInfo。 */
export const IFLOW_ACP_CLIENT_INFO = { name: "ff-pane", version: "0" } as const;

/**
 * initialize 报的 clientCapabilities。**必须显式带上**：iFlow 0.5.19 的
 * initialize 参数校验要求 clientCapabilities 字段存在（缺席回 -32602 Invalid
 * params，实现单真机踩过）——规范里它可缺省，iFlow 的 zod 校验更严。
 * 值如实全 false：FF-pane 不提供 fs / terminal 服务。
 */
export const IFLOW_ACP_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
} as const;

/** 未认证快速失败的 end.message（两道闸共用措辞前缀，单测钉住）。 */
export const IFLOW_NOAUTH_MESSAGE =
  "iflow 未认证（openai-compatible 三件套缺席）：请在 Profile 的 Provider 配置 API 密钥与 base_url" +
  "（iFlow 0.5.19 起仅 openai-compatible 认证类型可用，环境变量形态须 IFLOW_ 前缀）";

/** 无法映射为信封语义的工具请求被 fail-closed 拒绝时的留档说明（grok 同纪律）。 */
export const IFLOW_ACP_UNMAPPED_TOOL_NOTE =
  "该工具无法映射为权限信封语义，fail-closed 自动拒绝——不编造假类别骗用户点同意";

/** 权限回执误用（回执不存在/已回执的请求）。 */
export class IFlowAcpProtocolError extends Error {
  override readonly name = "IFlowAcpProtocolError";
}

/** startIFlowAcpTurn 的配置（env 已由调用方合并完毕）。 */
export interface IFlowAcpTurnConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly spawn: (spec: AgentProcessSpec) => AgentProcessHandle;
  readonly env: Readonly<Record<string, string>>;
  readonly baseEnv?: NodeJS.ProcessEnv | undefined;
  readonly stripApiKeyEnv?: boolean | undefined;
  /** 会话模式（default = 逐次审批 / plan = 只读），见 command.ts IFLOW_ACP_MODES。 */
  readonly mode: IFlowAcpMode;
  /** 控制面请求超时（测试注入；缺省协议层 30 s）。 */
  readonly controlTimeoutMs?: number | undefined;
  /** 优雅取消宽限毫秒（测试注入）。 */
  readonly cancelGraceMs?: number | undefined;
}

/** 一次 iFlow ACP 轮次句柄。 */
export interface IFlowAcpTurn {
  readonly commandLine: readonly string[];
  readonly events: AsyncIterable<AgentEvent>;
  respondPermission(nativeRequestId: string, decision: PermissionDecision): Promise<void>;
  cancel(): Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 推事件、单消费者拉取的异步队列（grok acp-turn 同款）。 */
function createEventSink(): {
  push(events: readonly AgentEvent[]): void;
  close(): void;
  stream(): AsyncGenerator<AgentEvent>;
} {
  const queue: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  function notify(): void {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  }
  return {
    push(events: readonly AgentEvent[]): void {
      if (closed) {
        return;
      }
      queue.push(...events);
      notify();
    },
    close(): void {
      closed = true;
      notify();
    },
    async *stream(): AsyncGenerator<AgentEvent> {
      for (;;) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

/**
 * ACP 权限请求的工具明细 → 权限信封载荷。返回 undefined = 无法用信封语义表达，
 * 调用方 fail-closed 自动拒绝。iFlow 的实测形态（fixtures + 实现单探针）：
 * - 写文件：kind="edit"，路径在 content[].diff（权限请求的 toolCall **不带 args**）；
 * - 命令：kind="execute"，**args 与 content 皆空**，命令原文只在 title
 *   （`node -v [current working directory …] (desc)`，commandFromIFlowTitle 剥出）。
 */
export function toIFlowPermissionPayload(
  toolCall: AcpToolCallView,
): PermissionRequestPayload | undefined {
  const kind = toolCall.toolKind ?? "";
  if (kind === "execute") {
    const command = iflowToolCommand(toolCall) ?? commandFromIFlowTitle(toolCall.title);
    return command === undefined ? undefined : { kind: "shell_command", command };
  }
  if (kind === "edit" || kind === "delete" || kind === "move") {
    const path = iflowToolFilePath(toolCall);
    return path === undefined ? undefined : { kind: "write_path", path };
  }
  if (kind === "read" || kind === "search") {
    const path = iflowToolFilePath(toolCall);
    return path === undefined ? undefined : { kind: "read_path", path };
  }
  if (kind === "fetch") {
    const rawInput = isJsonObject(toolCall.rawInput) ? toolCall.rawInput : {};
    const target = asString(rawInput["url"]);
    return { kind: "network", ...(target === undefined ? {} : { target }) };
  }
  return undefined;
}

/**
 * 用户裁决 → Agent 提供的选项。**恒选 `*_once`**（grok 同纪律）：iFlow 的选项面是
 * proceed_always(allow_always) / proceed_once(allow_once) / cancel(reject_once)
 * （真机实测三帧一致）——选 proceed_always 是会话级豁免，绕开权限层逐次裁决。
 * 同类 once 缺席时退回同前缀其他选项（调用方留档）。
 */
export function pickIFlowPermissionOption(
  options: readonly AcpPermissionOptionView[],
  decision: PermissionDecision,
): AcpPermissionOptionView | undefined {
  const prefix = decision === "allow" ? "allow" : "reject";
  return (
    options.find((option) => option.optionKind === `${prefix}_once`) ??
    options.find((option) => option.optionKind.startsWith(prefix))
  );
}

/** 启动一轮 iFlow ACP 轮次（spawn 同步发生）。 */
export function startIFlowAcpTurn(
  config: IFlowAcpTurnConfig,
  ctx: AdapterTurnContext,
): IFlowAcpTurn {
  const commandLine = [config.command, ...config.args];
  const sink = createEventSink();
  const pendingPermissions = new Map<string, (decision: PermissionDecision) => void>();
  let permissionSeq = 0;
  let sessionId: string | undefined;
  let cancelRequested = false;

  const mapper = createIFlowEventMapper();

  const spec: AgentProcessSpec = {
    command: config.command,
    args: config.args,
    cwd: ctx.cwd,
    // 双工协议前提：stdin 是管道（请求、审批回执、cancel 都走它）
    stdin: "pipe",
    env: { ...config.env },
    ...(config.baseEnv === undefined ? {} : { baseEnv: config.baseEnv }),
    ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
    ...(config.stripApiKeyEnv === undefined ? {} : { stripApiKeyEnv: config.stripApiKeyEnv }),
  };
  const handle = config.spawn(spec);
  const stderrTail = readStderrTail(handle.stderr).catch(() => "");

  function pickWithAudit(
    request: AcpPermissionRequestView,
    decision: PermissionDecision,
  ): AcpPermissionOptionView | undefined {
    const pick = pickIFlowPermissionOption(request.options, decision);
    if (pick !== undefined && !pick.optionKind.endsWith("_once")) {
      sink.push([
        toRawEvent(
          IFLOW_RUNTIME,
          request.raw,
          `同类 *_once 选项缺席，退回「${pick.optionKind}」（${pick.optionId}）` +
            "——该选项可能改变 iflow 会话内后续询问行为，留档备查",
        ),
      ]);
    }
    return pick;
  }

  function onSessionUpdate(notification: AcpSessionNotificationView): void {
    if (sessionId !== undefined && notification.sessionId !== sessionId) {
      sink.push([
        toRawEvent(IFLOW_RUNTIME, notification.raw, "非本轮会话的 session/update，仅留档"),
      ]);
      return;
    }
    sink.push([...mapper.mapUpdate(notification.update)]);
  }

  async function onPermissionRequest(
    request: AcpPermissionRequestView,
  ): Promise<AcpPermissionDecision> {
    if (sessionId !== undefined && request.sessionId !== sessionId) {
      sink.push([
        toRawEvent(IFLOW_RUNTIME, request.raw, "非本轮会话的权限请求，按 cancelled 回执"),
      ]);
      return { kind: "cancelled" };
    }
    const payload = toIFlowPermissionPayload(request.toolCall);
    if (payload === undefined) {
      // fail-closed：拒绝 + 记账（调研坑 2——拒绝后 iFlow 不会再给任何该工具的事件）
      sink.push([toRawEvent(IFLOW_RUNTIME, request.raw, IFLOW_ACP_UNMAPPED_TOOL_NOTE)]);
      sink.push([...mapper.registerDenied(request.toolCall)]);
      const reject = pickWithAudit(request, "deny");
      return reject === undefined
        ? { kind: "cancelled" }
        : { kind: "selected", optionId: reject.optionId };
    }
    permissionSeq += 1;
    const nativeRequestId = `iflow-acp-perm-${permissionSeq}`;
    // 先登记再让事件出流：消费方拿到 permission_request 时回执凭据必已就位
    const decision = await new Promise<PermissionDecision>((resolve) => {
      pendingPermissions.set(nativeRequestId, resolve);
      const diff = firstFileDiffOf(request.toolCall);
      const toolName = asString(request.toolCall.raw["toolName"]);
      sink.push([
        {
          kind: "permission_request",
          nativeRequestId,
          payload,
          ...(request.toolCall.title === undefined ? {} : { reason: request.toolCall.title }),
          ...(diff === undefined ? {} : { diff }),
          ...(toolName === undefined ? {} : { toolName }),
        },
      ]);
    });
    pendingPermissions.delete(nativeRequestId);
    if (decision === "deny") {
      // 坑 2 的记账时机：回执 deny 的当场。wire 上此后不会有该工具的任何事件——
      // denied 动作事件 + 阻断清单只能在这里产出（end_turn 时据此改判 failed）
      sink.push([...mapper.registerDenied(request.toolCall)]);
    }
    const pick = pickWithAudit(request, decision);
    if (pick === undefined) {
      sink.push([
        toRawEvent(
          IFLOW_RUNTIME,
          request.raw,
          `Agent 未提供可表达「${decision}」的权限选项，按 cancelled 回执`,
        ),
      ]);
      return { kind: "cancelled" };
    }
    return { kind: "selected", optionId: pick.optionId };
  }

  const connection = createAcpConnection({
    writable: handle.stdin ?? {
      write(): never {
        throw new Error("stdin 不可用（iflow 进程未启动成功）");
      },
    },
    readable: handle.stdout,
    handler: { onSessionUpdate, onPermissionRequest },
    onDiagnostic: (diagnostic) => {
      // 非 JSON banner 行（[iFlow ACP Agent] …）与未知通知都走这里：留档不丢证据
      sink.push([
        toRawEvent(
          IFLOW_RUNTIME,
          { reason: diagnostic.reason, raw: diagnostic.raw },
          `ACP 诊断：${diagnostic.reason}`,
        ),
      ]);
    },
  });

  const control =
    config.controlTimeoutMs === undefined ? {} : { timeoutMs: config.controlTimeoutMs };

  /** 轮次主体（early return 只表示终止事实已登记，收尾恒由 driveDone 兜住）。 */
  async function drive(): Promise<void> {
    const init = await connection.initialize(
      { clientInfo: IFLOW_ACP_CLIENT_INFO, clientCapabilities: IFLOW_ACP_CLIENT_CAPABILITIES },
      control,
    );
    // 未认证快速失败第一道闸：initialize 开箱即报 isAuthenticated（真机实测，
    // noauth fixture 第 3 行）。settings/env 三件套缺席时不进 session 期。
    if (init.raw["isAuthenticated"] === false) {
      mapper.registerError(IFLOW_NOAUTH_MESSAGE);
      return;
    }
    if (ctx.resume !== undefined && !init.loadSession) {
      // ACP 单通道：无降级路径可救，如实失败（loadSession 真机恒 true，防漂移）
      mapper.registerError("iflow 未声明 loadSession 能力，无法恢复会话");
      return;
    }

    if (ctx.resume !== undefined) {
      await connection.loadSession(
        { sessionId: ctx.resume.nativeSessionId, cwd: ctx.cwd },
        control,
      );
      sessionId = ctx.resume.nativeSessionId;
    } else {
      sessionId = (await connection.newSession({ cwd: ctx.cwd }, control)).sessionId;
    }
    sink.push([iflowSessionStart(sessionId, ctx.cwd, ctx.model)]);

    // 纪律闸（差异 2）：session/new 默认 currentModeId=yolo（真机实测）——全放行。
    // 恒切 default/plan；切失败即本轮失败（fail-closed，绝不带 yolo 跑）。
    await connection.setMode({ sessionId, modeId: config.mode }, control);

    const prompt = await connection.prompt({
      sessionId,
      prompt: [{ type: "text", text: ctx.prompt }],
    });
    mapper.registerPromptEnd(prompt.stopReason);
  }

  const driveDone = (async (): Promise<void> => {
    try {
      await drive();
    } catch (thrown) {
      // 会话期协议失败（含 -32000 auth 兜底闸、set_mode 失败、连接关闭）：
      // 已有终止事实时不覆盖（如 cancel 后连接关闭）
      if (!mapper.sawTerminalEvent()) {
        mapper.registerError(describeError(thrown));
      }
    }

    const sawTerminal = mapper.sawTerminalEvent();
    connection.close("轮次结束");
    const exit = await handle.kill();
    const tail = await stderrTail;
    sink.push(
      mapper.finalize({
        cancelled: cancelRequested || exit.kind === "timeout",
        spawnFailed: exit.kind === "spawn-failed",
        // 协议层已给终局时进程是被本层主动收掉的，退出码是收尾噪声（grok 同款）
        exitCode: sawTerminal ? null : exit.exitCode,
        error: sawTerminal ? null : (exit.error ?? (tail === "" ? null : tail)),
      }),
    );
    for (const [, resolve] of pendingPermissions) {
      resolve("deny");
    }
    pendingPermissions.clear();
    sink.close();
  })();

  return {
    commandLine,
    events: sink.stream(),

    async respondPermission(nativeRequestId, decision): Promise<void> {
      const resolve = pendingPermissions.get(nativeRequestId);
      if (resolve === undefined) {
        throw new IFlowAcpProtocolError(
          `权限请求「${nativeRequestId}」不属本轮或已回执过，无法回执`,
        );
      }
      pendingPermissions.delete(nativeRequestId);
      resolve(decision);
    },

    async cancel(): Promise<void> {
      cancelRequested = true;
      if (sessionId !== undefined && !connection.closed) {
        // 优雅取消：session/cancel 通知（协议层同时把未决权限请求 cancelled 回执），
        // 等 prompt 以 stopReason=cancelled 落定（真机实测成立）；宽限到才树杀兜底
        connection.cancel(sessionId);
        await raceWithTimeout(driveDone, config.cancelGraceMs ?? IFLOW_ACP_CANCEL_GRACE_MS);
      }
      connection.close("适配器取消");
      await handle.kill();
    },
  };
}

/** 权限请求 toolCall 里第一个 diff 载荷的 fileDiff 文本（审批 UI 的预览）。 */
function firstFileDiffOf(toolCall: AcpToolCallView): string | undefined {
  for (const entry of toolCall.content) {
    if (entry.kind === "diff") {
      return fileDiffOf(entry);
    }
  }
  return undefined;
}

/** 消费 stderr 并留最后一段（iFlow 的 Execution Info 与错误走 stderr）。 */
async function readStderrTail(stream: AsyncIterable<Buffer>): Promise<string> {
  const limit = 2 * 1024;
  let tail = "";
  for await (const chunk of stream) {
    tail = (tail + chunk.toString("utf8")).slice(-limit);
  }
  return tail.trim();
}

/** 竞速 promise 与超时；无论谁先到都清定时器。 */
async function raceWithTimeout(wait: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([wait, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
