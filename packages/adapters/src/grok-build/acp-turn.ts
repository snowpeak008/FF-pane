/**
 * Grok Build ACP 轮次（T8.5b）：spawn `grok agent stdio` 后经 T8.5a 的
 * `createAcpConnection` 走双工通道。**仍是一轮 = 一次 spawn**（与 headless 同构，
 * 编排层的 turn 模型不变）：prompt 轮次结束（或取消/失败）即收连接、杀进程；
 * 多轮连续性靠 `session/load`（ACP 的 loadSession 能力，与 headless `-r` 消费
 * 同一份会话存储——1.0.13 真机三向互通实测：ACP 新建 → headless `-r` 恢复 →
 * ACP session/load 再恢复，sessionId 全程同一 UUID）。
 *
 * 与 headless 模式的四点差异（全部真机实测，fixtures real-acp-*.jsonl）：
 * 1. **sessionId 在 session/new 响应就有**（headless 只在 end 才给，§7.3 坑 5）
 *    ——session_start 在轮次开头就发出，中断轮也拿得到续接凭据；
 * 2. **权限请求真转发**：不带 `--always-approve`，grok 经 session/request_permission
 *    请求逐次审批，本层把它映射为统一 permission_request 事件、经 respondPermission
 *    回执（guard 的信封裁决 → 自动应答或上浮等用户，与 claude 的权限桥同款）；
 * 3. **优雅取消**：session/cancel 通知 → grok 自己收工具、prompt 以
 *    stopReason=cancelled 落定；宽限期未落定仍走 kill 树杀兜底；
 * 4. **事件映射复用现行 mapper**：headless 的 streaming-json 本就是 ACP session
 *    update 的投影（grok-build.md §2），把 AcpSessionUpdateView 还原成
 *    headless 形态的记录（type 字段 + 从 `_meta["x.ai/tool"]` 提升 kind/toolName
 *    ——ACP wire 的 tool_call 顶层**不带**这两个字段，真机核实）喂给
 *    createGrokEventMapper，denial 改判 / diff 渲染 / 阻断证据 / end 语义
 *    一行不重写。
 *
 * 降级合同（adapter.ts 消费）：**只有 initialize 阶段的失败**（spawn 失败 /
 * 握手错 / 超时 / 连接关闭）经 `outcome` 报 `{ok:false}`，此时本层已按
 * T8.5a 验收 §2-3 的接线提醒 close 连接 + kill 收进程、且未发出任何事件——
 * 调用方可安全降级 headless 重跑本轮。session/new 及之后的失败不降级
 * （那不是「不支持 agent stdio」的证据），如实以 end(failed) 收尾。
 */

/// <reference types="node" />

import type { NativeSessionId, PermissionRequestPayload } from "@ff-pane/shared";
import type {
  AcpPermissionDecision,
  AcpPermissionOptionView,
  AcpPermissionRequestView,
  AcpSessionNotificationView,
  AcpSessionUpdateView,
  AcpToolCallView,
} from "../acp/index.js";
import {
  ACP_ERROR_AUTH_REQUIRED,
  AcpConnectionClosedError,
  AcpRemoteError,
  createAcpConnection,
} from "../acp/index.js";
import type { AdapterTurnContext, PermissionDecision } from "../adapter.js";
import type { AgentEvent } from "../events/index.js";
import { isJsonObject, toRawEvent } from "../events/index.js";
import type { AgentProcessSpec } from "../process/index.js";
import { GROK_BUILD_RUNTIME } from "./command.js";
import { renderGrokDiffFromContent } from "./diff.js";
import { createGrokEventMapper } from "./mapper.js";
import type { SpawnAgentProcessFn } from "./turn-support.js";
import { raceWithTimeout, readStderrTail } from "./turn-support.js";

/** cancel 通知发出后等 prompt 优雅落定的宽限期，超时即树杀兜底。 */
export const GROK_ACP_CANCEL_GRACE_MS = 5_000;

/**
 * initialize 握手时报的 clientInfo（规范预告将来必填）。
 * 适配器层不知宿主版本号，版本恒报 "0"——名字才是有信息量的那半。
 */
export const GROK_ACP_CLIENT_INFO = { name: "ff-pane", version: "0" } as const;

/**
 * ACP 模式下 stopReason=cancelled 的 end.message（覆盖 mapper 的 headless 缺省
 * 措辞——那句「须以 --always-approve 运行」在有审批通道的本模式下是误导）。
 */
export const GROK_ACP_CANCELLED_MESSAGE =
  "grok 以 stopReason=cancelled 收尾：本轮被取消，或有权限请求被用户/权限层拒绝" +
  "（ACP 模式下审批经 FF-pane 权限层逐次裁决）";

/** 无法映射为信封语义的工具请求被 fail-closed 拒绝时的留档说明。 */
export const GROK_ACP_UNMAPPED_TOOL_NOTE =
  "该工具无法映射为权限信封语义（§7 的 5 类都套不上），fail-closed 自动拒绝——" +
  "不编造假类别骗用户点同意，也不悬着让 Agent 永远等";

/** 权限回执误用（回执不存在/已回执的请求）。 */
export class GrokAcpProtocolError extends Error {
  override readonly name = "GrokAcpProtocolError";
}

/** startGrokAcpAttempt 的配置（env 已由调用方合并完毕）。 */
export interface GrokAcpTurnConfig {
  /** 已解析的可执行文件。 */
  readonly command: string;
  /** buildGrokAcpArgs 的产物。 */
  readonly args: readonly string[];
  readonly spawn: SpawnAgentProcessFn;
  readonly env: Readonly<Record<string, string>>;
  readonly stripApiKeyEnv?: boolean | undefined;
  /** initialize 握手超时；缺省沿用协议层控制面缺省（30 s）。 */
  readonly handshakeTimeoutMs?: number | undefined;
  /** 优雅取消宽限期，缺省 GROK_ACP_CANCEL_GRACE_MS。 */
  readonly cancelGraceMs?: number | undefined;
}

/** ACP 尝试的判决：ok 后事件流有效；否则进程已收、可降级。 */
export type GrokAcpAttemptOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** 一次 ACP 轮次尝试。 */
export interface GrokAcpAttempt {
  readonly commandLine: readonly string[];
  /** initialize 成败的判决（ok:false 时进程已收、零事件已发，可降级）。 */
  readonly outcome: Promise<GrokAcpAttemptOutcome>;
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

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 推事件、单消费者拉取的异步队列（轮次驱动与通知回调都往里推）。 */
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

/** 从 wire 记录里取 grok 的工具元数据（`_meta["x.ai/tool"]`）。 */
function xaiToolMeta(raw: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const meta = raw["_meta"];
  if (!isJsonObject(meta)) {
    return undefined;
  }
  const tool = meta["x.ai/tool"];
  return isJsonObject(tool) ? tool : undefined;
}

/**
 * AcpSessionUpdateView → headless streaming-json 形态的记录。
 *
 * headless 流本就是 ACP update 的投影（grok-build.md §2），此处做逆投影以复用
 * 现行 mapper。两处 ACP wire 与 headless 的实测差异要补齐：
 * - chunk 的文本在 `content.text`，headless 在顶层 `data`；
 * - tool_call 的 `kind`/`toolName` 在 ACP wire **顶层缺席**（真机核实：仅
 *   tool_call_update 偶带 kind），权威值在 `_meta["x.ai/tool"]` 的 kind/name
 *   ——headless 投影把它们提升到顶层，这里照做，否则 mapper 认不出文件/命令类。
 */
export function acpUpdateToNativeRecord(update: AcpSessionUpdateView): Record<string, unknown> {
  switch (update.kind) {
    case "agent_message_chunk":
    case "user_message_chunk":
    case "agent_thought_chunk": {
      if (update.kind === "user_message_chunk") {
        // headless 无对应事件（提示词回显），保持未归类 → mapper 走 raw 留档
        return { ...update.raw, type: "user_message_chunk" };
      }
      const text = update.content.text;
      return {
        ...update.raw,
        type: update.kind === "agent_message_chunk" ? "text" : "thought",
        ...(text === undefined ? {} : { data: text }),
      };
    }
    case "tool_call":
    case "tool_call_update": {
      const raw = update.toolCall.raw;
      const tool = xaiToolMeta(raw);
      const kind =
        asString(raw["kind"]) ?? (tool === undefined ? undefined : asString(tool["kind"]));
      const toolName =
        asString(raw["toolName"]) ?? (tool === undefined ? undefined : asString(tool["name"]));
      return {
        ...raw,
        type: update.kind,
        ...(kind === undefined ? {} : { kind }),
        ...(toolName === undefined ? {} : { toolName }),
      };
    }
    case "plan":
      return { ...update.raw, type: "plan" };
    case "opaque":
      return { ...update.raw, type: update.sessionUpdate };
  }
}

/**
 * ACP 权限请求的工具明细 → 权限信封载荷（§7 的 5 类）。
 * 返回 undefined = 无法用信封语义表达（spawn_subagent 等逃出执行模型的工具），
 * 调用方 fail-closed 自动拒绝（与 claude 适配器的 toPermissionPayload 同一纪律）。
 */
export function toGrokAcpPermissionPayload(
  toolCall: AcpToolCallView,
  cwd: string,
): PermissionRequestPayload | undefined {
  const rawInput = isJsonObject(toolCall.rawInput) ? toolCall.rawInput : {};
  const tool = xaiToolMeta(toolCall.raw);
  const kind = toolCall.toolKind ?? (tool === undefined ? undefined : asString(tool["kind"])) ?? "";
  const filePath =
    asString(rawInput["file_path"]) ?? asString(rawInput["path"]) ?? toolCall.locations[0]?.path;
  const command = asString(rawInput["command"]);

  if (kind === "execute" || command !== undefined) {
    return command === undefined ? undefined : { kind: "shell_command", command };
  }
  if (kind === "write" || kind === "edit" || kind === "delete" || kind === "move") {
    return filePath === undefined ? undefined : { kind: "write_path", path: filePath };
  }
  if (kind === "read" || kind === "search") {
    return { kind: "read_path", path: filePath ?? cwd };
  }
  if (kind === "fetch") {
    const target = asString(rawInput["url"]);
    return { kind: "network", ...(target === undefined ? {} : { target }) };
  }
  return undefined;
}

/**
 * 用户裁决 → Agent 提供的选项。**刻意优先 `*_once`**：FF-pane 的裁决是逐次的，
 * 选 allow_always/reject_always 会让 grok 后续同类操作不再询问——那等于把一次
 * 放行升格成会话级豁免，绕开权限层的逐次裁决。同类 once 缺席时才退回同前缀
 * 的其他选项（此时留档由调用方负责——startGrokAcpAttempt 的 pickWithAudit
 * 在命中该退路时 push 一条 raw 留档；真机选项面恒含 once（fixture 两帧实证），
 * 退路目前不可达，留档是为将来 grok 改选项面时保住证据）。
 */
export function pickAcpPermissionOption(
  options: readonly AcpPermissionOptionView[],
  decision: PermissionDecision,
): AcpPermissionOptionView | undefined {
  const prefix = decision === "allow" ? "allow" : "reject";
  return (
    options.find((option) => option.optionKind === `${prefix}_once`) ??
    options.find((option) => option.optionKind.startsWith(prefix))
  );
}

/** prompt 响应 `_meta.usage`（camelCase）→ headless end.usage（snake_case）。 */
function usageRecordOf(
  raw: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const meta = raw["_meta"];
  if (!isJsonObject(meta)) {
    return undefined;
  }
  const usage = meta["usage"];
  if (!isJsonObject(usage)) {
    return undefined;
  }
  const input = asNumber(usage["inputTokens"]);
  const output = asNumber(usage["outputTokens"]);
  const cached = asNumber(usage["cachedReadTokens"]);
  const reasoning = asNumber(usage["reasoningTokens"]);
  const total = asNumber(usage["totalTokens"]);
  const mapped = {
    ...(input === undefined ? {} : { input_tokens: input }),
    ...(output === undefined ? {} : { output_tokens: output }),
    ...(cached === undefined ? {} : { cache_read_input_tokens: cached }),
    ...(reasoning === undefined ? {} : { reasoning_tokens: reasoning }),
    ...(total === undefined ? {} : { total_tokens: total }),
  };
  return Object.keys(mapped).length === 0 ? undefined : mapped;
}

/** 权限请求事件的 toolName（`_meta["x.ai/tool"].name` 优先，rawInput.variant 兜底）。 */
function toolNameOf(toolCall: AcpToolCallView): string | undefined {
  const tool = xaiToolMeta(toolCall.raw);
  const metaName = tool === undefined ? undefined : asString(tool["name"]);
  const variant = isJsonObject(toolCall.rawInput)
    ? asString(toolCall.rawInput["variant"])
    : undefined;
  return metaName ?? variant;
}

/**
 * session/new 的认证重试：-32000 auth_required 且 Agent 声明了 `xai.api_key`
 * 认证方式时，authenticate 一次再试。**只认这一种方式**：`grok.com` 是浏览器
 * OAuth，headless 服务进程里自动触发它会挂起等一个不存在的浏览器交互——
 * 那不是重试，是把失败变成假死。其余情况错误原样上抛。
 */
async function newSessionWithAuthRetry(
  connection: ReturnType<typeof createAcpConnection>,
  authMethods: readonly Readonly<Record<string, unknown>>[],
  cwd: string,
): Promise<{ sessionId: string }> {
  try {
    return await connection.newSession({ cwd });
  } catch (thrown) {
    const canRetry =
      thrown instanceof AcpRemoteError &&
      thrown.code === ACP_ERROR_AUTH_REQUIRED &&
      authMethods.some((method) => method["id"] === "xai.api_key");
    if (!canRetry) {
      throw thrown;
    }
    await connection.authenticate("xai.api_key");
    return await connection.newSession({ cwd });
  }
}

/** 启动一次 ACP 轮次尝试（spawn 同步发生，与 headless 的 startTurn 语义一致）。 */
export function startGrokAcpAttempt(
  config: GrokAcpTurnConfig,
  ctx: AdapterTurnContext,
): GrokAcpAttempt {
  const commandLine = [config.command, ...config.args];
  const sink = createEventSink();
  const pendingPermissions = new Map<string, (decision: PermissionDecision) => void>();
  let permissionSeq = 0;
  let sessionId: string | undefined;
  let cancelRequested = false;

  const mapper = createGrokEventMapper({
    cwd: ctx.cwd,
    ...(ctx.model === undefined ? {} : { model: ctx.model }),
    cancelledMessage: GROK_ACP_CANCELLED_MESSAGE,
  });
  let recordSeq = 0;
  function mapNative(native: Record<string, unknown>): readonly AgentEvent[] {
    recordSeq += 1;
    return mapper.map({ ok: true, lineNumber: recordSeq, raw: "", value: native });
  }

  const spec: AgentProcessSpec = {
    command: config.command,
    args: config.args,
    cwd: ctx.cwd,
    // 双工协议的前提：stdin 必须是管道（请求、审批回执、cancel 都走它）
    stdin: "pipe",
    env: { ...config.env },
    ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
    ...(config.stripApiKeyEnv === undefined ? {} : { stripApiKeyEnv: config.stripApiKeyEnv }),
  };
  const handle = config.spawn(spec);
  const stderrTail = readStderrTail(handle.stderr).catch(() => "");

  /**
   * 选项挑选 + 退路留档（pickAcpPermissionOption 注释的「留档由调用方负责」）：
   * 命中非 `*_once` 选项时 push raw 证据——always 类会改变 grok 会话内后续
   * 询问行为，真机选项面恒含 once（fixture 实证）故当前不可达，留档是为将来
   * grok 改选项面时不静默豁免。
   */
  function pickWithAudit(
    request: AcpPermissionRequestView,
    decision: PermissionDecision,
  ): AcpPermissionOptionView | undefined {
    const pick = pickAcpPermissionOption(request.options, decision);
    if (pick !== undefined && !pick.optionKind.endsWith("_once")) {
      sink.push([
        toRawEvent(
          GROK_BUILD_RUNTIME,
          request.raw,
          `同类 *_once 选项缺席，退回「${pick.optionKind}」（${pick.optionId}）` +
            "——该选项可能改变 grok 会话内后续询问行为，留档备查",
        ),
      ]);
    }
    return pick;
  }

  function onSessionUpdate(notification: AcpSessionNotificationView): void {
    if (sessionId !== undefined && notification.sessionId !== sessionId) {
      // --no-leader 下不该发生；真发生就是对端缺陷证据，留档不映射
      sink.push([
        toRawEvent(GROK_BUILD_RUNTIME, notification.raw, "非本轮会话的 session/update，仅留档"),
      ]);
      return;
    }
    sink.push(mapNative(acpUpdateToNativeRecord(notification.update)));
  }

  async function onPermissionRequest(
    request: AcpPermissionRequestView,
  ): Promise<AcpPermissionDecision> {
    if (sessionId !== undefined && request.sessionId !== sessionId) {
      sink.push([
        toRawEvent(GROK_BUILD_RUNTIME, request.raw, "非本轮会话的权限请求，按 cancelled 回执"),
      ]);
      return { kind: "cancelled" };
    }
    const payload = toGrokAcpPermissionPayload(request.toolCall, ctx.cwd);
    if (payload === undefined) {
      sink.push([toRawEvent(GROK_BUILD_RUNTIME, request.raw, GROK_ACP_UNMAPPED_TOOL_NOTE)]);
      const reject = pickWithAudit(request, "deny");
      return reject === undefined
        ? { kind: "cancelled" }
        : { kind: "selected", optionId: reject.optionId };
    }
    permissionSeq += 1;
    const nativeRequestId = `grok-acp-perm-${permissionSeq}`;
    // 先登记再让事件出流：消费方拿到 permission_request 时回执凭据必已就位
    const decision = await new Promise<PermissionDecision>((resolve) => {
      pendingPermissions.set(nativeRequestId, resolve);
      const diff = renderGrokDiffFromContent(request.toolCall.raw["content"]);
      const toolName = toolNameOf(request.toolCall);
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
    const pick = pickWithAudit(request, decision);
    if (pick === undefined) {
      sink.push([
        toRawEvent(
          GROK_BUILD_RUNTIME,
          request.raw,
          `Agent 未提供可表达「${decision}」的权限选项，按 cancelled 回执`,
        ),
      ]);
      return { kind: "cancelled" };
    }
    return { kind: "selected", optionId: pick.optionId };
  }

  const connection = createAcpConnection({
    // spawn 失败时 stdin 为 null：给一个恒抛的写口，让 initialize 立即失败进降级
    writable: handle.stdin ?? {
      write(): never {
        throw new Error("stdin 不可用（grok 进程未启动成功）");
      },
    },
    readable: handle.stdout,
    handler: { onSessionUpdate, onPermissionRequest },
    onDiagnostic: (diagnostic) => {
      // grok 的 _x.ai/* 私有通知等全部走这里：不映射、逐条留档（丢弃即丢证据）
      sink.push([
        toRawEvent(
          GROK_BUILD_RUNTIME,
          { reason: diagnostic.reason, raw: diagnostic.raw },
          `ACP 诊断：${diagnostic.reason}`,
        ),
      ]);
    },
  });

  let settleOutcome!: (outcome: GrokAcpAttemptOutcome) => void;
  const outcome = new Promise<GrokAcpAttemptOutcome>((resolve) => {
    settleOutcome = resolve;
  });

  const driveDone = (async (): Promise<void> => {
    async function degrade(reason: string): Promise<void> {
      // T8.5a 验收 §2-3 接线提醒：catch AcpHandshakeError（连同一切握手期失败）
      // 后 close 连接 + 收进程。此时零事件已发出，调用方可降级 headless 重跑
      connection.close("握手失败，降级现行模式");
      await handle.kill();
      await stderrTail;
      sink.close();
      settleOutcome({ ok: false, reason });
    }

    let authMethods: readonly Readonly<Record<string, unknown>>[];
    try {
      const init = await connection.initialize(
        { clientInfo: GROK_ACP_CLIENT_INFO },
        config.handshakeTimeoutMs === undefined ? {} : { timeoutMs: config.handshakeTimeoutMs },
      );
      authMethods = init.authMethods;
      if (ctx.resume !== undefined && !init.loadSession) {
        // 归为降级条件而非轮内失败：headless 的 -r 消费同一份会话存储（互通实测），
        // 降级路径能恢复这轮要的会话；在 ACP 里硬跑只会白报一个 failed
        await degrade("Agent 未声明 loadSession 能力，无法经 ACP 恢复会话");
        return;
      }
    } catch (thrown) {
      await degrade(describeError(thrown));
      return;
    }
    settleOutcome({ ok: true });

    try {
      if (ctx.resume !== undefined) {
        await connection.loadSession({ sessionId: ctx.resume.nativeSessionId, cwd: ctx.cwd });
        sessionId = ctx.resume.nativeSessionId;
      } else {
        sessionId = (await newSessionWithAuthRetry(connection, authMethods, ctx.cwd)).sessionId;
      }
      // sessionId 此刻就有（ACP 相对 headless 的关键改善，§7.3 坑 5 在本模式不存在）：
      // session_start 先于一切产出发出，中断轮也留得下续接凭据
      sink.push([
        {
          kind: "session_start",
          native: { nativeSessionId: sessionId as NativeSessionId, cwd: ctx.cwd },
          ...(ctx.model === undefined ? {} : { model: ctx.model }),
        },
      ]);
      const prompt = await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: ctx.prompt }],
      });
      const usage = usageRecordOf(prompt.raw);
      // 合成 headless 形态的 end 记录喂给 mapper：stopReason 语义（cancelled 不是
      // 成功、非 end_turn 报失败、end_turn 但有阻断也报失败）全部复用（约定 1）。
      // 刻意不带 sessionId——session_start 已在上面发过，带了会重复发
      mapNative({
        type: "end",
        stopReason: prompt.stopReason,
        ...(usage === undefined ? {} : { usage }),
      });
    } catch (thrown) {
      if (!(thrown instanceof AcpConnectionClosedError)) {
        // 会话期协议失败（auth / loadSession / prompt 错误响应）：如实登记为 error
        mapNative({ type: "error", message: describeError(thrown) });
      }
      // 连接关闭（进程死亡/被杀/超时树杀）不登记：让 finalize 按进程终局兜底
    }

    const sawTerminal = mapper.sawTerminalEvent();
    connection.close("轮次结束");
    const exit = await handle.kill();
    const tail = await stderrTail;
    // 协议层已给出终局（end/error 已登记）时，进程是被本层主动收掉的——
    // 它的退出码/终止原因是收尾噪声，不该混进 end 事件
    sink.push(
      mapper.finalize({
        cancelled: cancelRequested || exit.kind === "timeout",
        spawnFailed: exit.kind === "spawn-failed",
        exitCode: sawTerminal ? null : exit.exitCode,
        error: sawTerminal ? null : (exit.error ?? (tail === "" ? null : tail)),
      }),
    );
    // 未回执的权限裁决：连接已关（回执必然被丢弃），resolve 掉让悬挂的 handler 收尾
    for (const [, resolve] of pendingPermissions) {
      resolve("deny");
    }
    pendingPermissions.clear();
    sink.close();
  })();

  return {
    commandLine,
    outcome,
    events: sink.stream(),

    async respondPermission(nativeRequestId, decision): Promise<void> {
      const resolve = pendingPermissions.get(nativeRequestId);
      if (resolve === undefined) {
        throw new GrokAcpProtocolError(
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
        // 等 prompt 以 stopReason=cancelled 落定；宽限到仍没落定才树杀兜底
        connection.cancel(sessionId);
        await raceWithTimeout([driveDone], config.cancelGraceMs ?? GROK_ACP_CANCEL_GRACE_MS);
      }
      connection.close("适配器取消");
      await handle.kill();
    },
  };
}
