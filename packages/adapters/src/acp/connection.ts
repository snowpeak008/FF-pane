/**
 * ACP 双工通道（T8.5a）：AcpConnection——FF-pane 作为 ACP Client 的连接对象。
 *
 * **不 spawn**：读写口经构造注入（writable = Agent 的 stdin 写入口，readable =
 * Agent 的 stdout 异步迭代，Node Readable / PassThrough 天然满足），进程生命
 * 周期归 T8.5b 的适配器。本层因此零 Electron / 零子进程依赖，可用假流单测全部
 * 协议行为。
 *
 * 职责边界：
 * 1. 出站请求的 id 关联与未决表：响应按 id 回配；连接关闭（stdout 结束 / 显式
 *    close）时未决请求**全部 reject**（AcpConnectionClosedError），不留悬挂 await；
 * 2. 控制面请求超时（initialize / authenticate / session new+load 缺省
 *    DEFAULT_ACP_REQUEST_TIMEOUT_MS）；**prompt 缺省不限时**——轮次时长由模型
 *    决定，看门狗语义归编排层 / 适配器（既有 turn 模型），协议层替它定超时
 *    只会制造假失败。两处都可按调用覆盖（0 = 不限时）；
 * 3. Agent 反向流量的分派：session/update 通知 → onSessionUpdate；
 *    session/request_permission 请求 → onPermissionRequest（回执由本层编码回写）；
 *    未知方法的请求回 method not found，未知通知与畸形行进诊断通道（不抛不断流）；
 * 4. cancel 语义（规范硬性要求）：session/cancel 通知发出时，该会话**所有未决的
 *    权限请求立即以 cancelled 回执**（规范 Cancellation 节的 MUST），迟到的
 *    handler 结果不再二次回写。
 *
 * 通知乱序容错：双工通道上 session/update 可能先于 session/new 的响应到达
 * （Agent 先流后回），分派与未决表互不阻塞——通知不进未决表，天然无序安全。
 */

import { createLineDecoder } from "../events/jsonl.js";
import type {
  AcpClassifiedMessage,
  AcpIncomingRequest,
  AcpJsonRpcError,
  AcpJsonRpcId,
} from "./jsonrpc.js";
import {
  ACP_JSON_RPC_INTERNAL_ERROR,
  ACP_JSON_RPC_INVALID_PARAMS,
  ACP_JSON_RPC_METHOD_NOT_FOUND,
  buildAcpError,
  buildAcpNotification,
  buildAcpRequest,
  buildAcpResult,
  classifyAcpLine,
  encodeAcpMessage,
} from "./jsonrpc.js";
import {
  parseInitializeResult,
  parseLoadSessionResult,
  parseNewSessionResult,
  parsePermissionRequest,
  parsePromptResult,
  parseSessionNotification,
} from "./parse.js";
import type {
  AcpInitializeOptions,
  AcpInitializeResult,
  AcpLoadSessionParams,
  AcpLoadSessionResult,
  AcpNewSessionParams,
  AcpNewSessionResult,
  AcpPermissionDecision,
  AcpPermissionRequestView,
  AcpPromptParams,
  AcpPromptResult,
  AcpSessionNotificationView,
} from "./types.js";
import { ACP_AGENT_METHODS, ACP_CLIENT_METHODS, ACP_PROTOCOL_VERSION } from "./types.js";

/** 控制面请求的缺省超时（毫秒）。prompt 不适用（见模块头第 2 条）。 */
export const DEFAULT_ACP_REQUEST_TIMEOUT_MS = 30_000;

/** Agent 回了错误响应。code/data 原样携带（如 -32000 auth_required）。 */
export class AcpRemoteError extends Error {
  override readonly name = "AcpRemoteError";
  readonly code: number;
  readonly data?: unknown;

  constructor(method: string, error: AcpJsonRpcError) {
    super(`ACP ${method} 失败（${error.code}）：${error.message}`);
    this.code = error.code;
    if (error.data !== undefined) {
      this.data = error.data;
    }
  }
}

/** 请求超时（本端看门狗，非 Agent 回执）。 */
export class AcpTimeoutError extends Error {
  override readonly name = "AcpTimeoutError";

  constructor(method: string, timeoutMs: number) {
    super(`ACP ${method} 超时（${timeoutMs} ms 无响应）`);
  }
}

/** 连接已关闭：stdout 结束 / 显式 close / 读取口抛错。未决请求以此 reject。 */
export class AcpConnectionClosedError extends Error {
  override readonly name = "AcpConnectionClosedError";

  constructor(reason: string) {
    super(`ACP 连接已关闭：${reason}`);
  }
}

/** 握手失败：响应形状非法或协议版本谈不拢（规范：谈不拢客户端应断开）。 */
export class AcpHandshakeError extends Error {
  override readonly name = "AcpHandshakeError";
}

/** 诊断条目：畸形行 / 未知通知 / 无主响应等，不抛不断流，原文留档。 */
export interface AcpDiagnostic {
  readonly reason: string;
  readonly raw: string;
}

/** Agent 反向流量的处理器（由消费方注入；b 单把它接到 FF-pane 的权限信封）。 */
export interface AcpClientHandler {
  /** session/update 流式通知（已解析视图；不回包）。 */
  onSessionUpdate(notification: AcpSessionNotificationView): void;
  /**
   * session/request_permission：给出用户裁决。抛错时本层回 internal error 响应，
   * 连接不受影响。若在等待期间该会话被 cancel，本层已抢先回 cancelled，
   * 迟到的返回值被丢弃。
   */
  onPermissionRequest(request: AcpPermissionRequestView): Promise<AcpPermissionDecision>;
}

/** 单次请求的可选覆盖。 */
export interface AcpRequestOverrides {
  /** 超时毫秒；0 = 不限时。缺省见各方法注释。 */
  readonly timeoutMs?: number;
}

/** 构造选项。 */
export interface AcpConnectionOptions {
  /** Agent stdin 的写入口（Node Writable / PassThrough 的 write 即可）。 */
  readonly writable: { write(chunk: string): unknown };
  /** Agent stdout 的读取口（Node Readable 的 Symbol.asyncIterator 即可）。 */
  readonly readable: AsyncIterable<string | Uint8Array>;
  /** Agent 反向流量处理器。 */
  readonly handler: AcpClientHandler;
  /** 控制面请求缺省超时，缺省 DEFAULT_ACP_REQUEST_TIMEOUT_MS。 */
  readonly requestTimeoutMs?: number;
  /** 诊断通道（畸形行等；缺省丢弃）。 */
  readonly onDiagnostic?: (diagnostic: AcpDiagnostic) => void;
}

/** ACP 客户端连接。 */
export interface AcpConnection {
  /**
   * initialize 握手：报 ACP_PROTOCOL_VERSION 与能力，校验 Agent 回的版本。
   * Agent 回的版本 ≠ 本端支持的版本时抛 AcpHandshakeError（规范：客户端不支持
   * 回来的版本就该断开——本端只支持版本 1，不做多版本兼容表，谈不拢即拒绝）。
   */
  initialize(
    options?: AcpInitializeOptions,
    overrides?: AcpRequestOverrides,
  ): Promise<AcpInitializeResult>;
  /** authenticate（methodId 取自 initialize 响应的 authMethods）。 */
  authenticate(methodId: string, overrides?: AcpRequestOverrides): Promise<void>;
  /** session/new。 */
  newSession(
    params: AcpNewSessionParams,
    overrides?: AcpRequestOverrides,
  ): Promise<AcpNewSessionResult>;
  /** session/load（Agent 须声明 loadSession 能力；历史经 session/update 流回）。 */
  loadSession(
    params: AcpLoadSessionParams,
    overrides?: AcpRequestOverrides,
  ): Promise<AcpLoadSessionResult>;
  /** session/prompt 轮次。缺省**不限时**（模块头第 2 条），overrides 可加看门狗。 */
  prompt(params: AcpPromptParams, overrides?: AcpRequestOverrides): Promise<AcpPromptResult>;
  /**
   * session/cancel 通知（无响应）。同会话未决权限请求立即以 cancelled 回执；
   * 轮次的真正终结以 prompt 响应 stopReason === "cancelled" 为准。
   */
  cancel(sessionId: string): void;
  /** 关闭连接：未决请求全部 reject，后续调用即抛。幂等。 */
  close(reason?: string): void;
  /** 连接是否已关闭。 */
  readonly closed: boolean;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

/** 在飞的入站权限请求（cancel 抢答用）。 */
interface InflightPermission {
  readonly id: AcpJsonRpcId;
  readonly sessionId: string;
  settled: boolean;
}

/** 创建 ACP 连接并立即开始消费读取口。 */
export function createAcpConnection(options: AcpConnectionOptions): AcpConnection {
  const defaultTimeoutMs = options.requestTimeoutMs ?? DEFAULT_ACP_REQUEST_TIMEOUT_MS;
  const pending = new Map<AcpJsonRpcId, PendingRequest>();
  const inflightPermissions = new Map<AcpJsonRpcId, InflightPermission>();
  let nextId = 1;
  let closed = false;
  let closeReason = "";

  function diagnose(reason: string, raw: string): void {
    options.onDiagnostic?.({ reason, raw });
  }

  function writeFrame(message: Parameters<typeof encodeAcpMessage>[0]): void {
    options.writable.write(encodeAcpMessage(message));
  }

  function close(reason = "调用方关闭"): void {
    if (closed) {
      return;
    }
    closed = true;
    closeReason = reason;
    for (const [, entry] of pending) {
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
      }
      entry.reject(new AcpConnectionClosedError(reason));
    }
    pending.clear();
    inflightPermissions.clear();
  }

  function sendRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (closed) {
      return Promise.reject(new AcpConnectionClosedError(closeReason));
    }
    const id = nextId;
    nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              pending.delete(id);
              reject(new AcpTimeoutError(method, timeoutMs));
            }, timeoutMs)
          : undefined;
      pending.set(id, { method, resolve, reject, timer });
      try {
        writeFrame(buildAcpRequest(id, method, params));
      } catch (thrown) {
        pending.delete(id);
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        reject(thrown instanceof Error ? thrown : new Error(String(thrown)));
      }
    });
  }

  function settleResponse(message: Extract<AcpClassifiedMessage, { kind: "response" }>): void {
    const entry = pending.get(message.id);
    if (entry === undefined) {
      // 迟到的响应（超时后到达）或对端串了 id：留档，不影响其他未决请求
      diagnose(`无主响应（id: ${String(message.id)}，可能已超时）`, JSON.stringify(message));
      return;
    }
    pending.delete(message.id);
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
    }
    if (message.error !== undefined) {
      entry.reject(new AcpRemoteError(entry.method, message.error));
      return;
    }
    entry.resolve(message.result);
  }

  function respondPermission(id: AcpJsonRpcId, decision: AcpPermissionDecision): void {
    const outcome =
      decision.kind === "cancelled"
        ? { outcome: "cancelled" }
        : { outcome: "selected", optionId: decision.optionId };
    writeFrame(buildAcpResult(id, { outcome }));
  }

  function handlePermissionRequest(request: AcpIncomingRequest): void {
    const view = parsePermissionRequest(request.params);
    if (view === undefined) {
      writeFrame(
        buildAcpError(
          request.id,
          ACP_JSON_RPC_INVALID_PARAMS,
          "session/request_permission 参数非法（缺 sessionId / toolCallId / options）",
        ),
      );
      return;
    }
    const inflight: InflightPermission = {
      id: request.id,
      sessionId: view.sessionId,
      settled: false,
    };
    inflightPermissions.set(request.id, inflight);
    void (async () => {
      let decision: AcpPermissionDecision;
      try {
        decision = await options.handler.onPermissionRequest(view);
      } catch (thrown) {
        if (!inflight.settled && !closed) {
          inflight.settled = true;
          inflightPermissions.delete(request.id);
          writeFrame(
            buildAcpError(
              request.id,
              ACP_JSON_RPC_INTERNAL_ERROR,
              `权限处理器异常：${thrown instanceof Error ? thrown.message : String(thrown)}`,
            ),
          );
        }
        return;
      }
      // cancel 已抢答 / 连接已关：迟到的裁决丢弃，不二次回写
      if (inflight.settled || closed) {
        return;
      }
      inflight.settled = true;
      inflightPermissions.delete(request.id);
      respondPermission(request.id, decision);
    })();
  }

  function handleIncomingRequest(request: AcpIncomingRequest): void {
    if (request.method === ACP_CLIENT_METHODS.sessionRequestPermission) {
      handlePermissionRequest(request);
      return;
    }
    // fs/* terminal/* 等：本端未声明能力也不实现，如实回 method not found
    writeFrame(
      buildAcpError(request.id, ACP_JSON_RPC_METHOD_NOT_FOUND, `未知方法：${request.method}`),
    );
  }

  function handleNotification(method: string, params: unknown, raw: string): void {
    if (method === ACP_CLIENT_METHODS.sessionUpdate) {
      const view = parseSessionNotification(params);
      if (view === undefined) {
        diagnose("session/update 参数非法（缺 sessionId 或 update）", raw);
        return;
      }
      options.handler.onSessionUpdate(view);
      return;
    }
    // 未知通知：按 JSON-RPC 规定不回包，留档即可
    diagnose(`未知通知：${method}`, raw);
  }

  function dispatchLine(line: string): void {
    const message = classifyAcpLine(line);
    if (message === undefined) {
      return;
    }
    switch (message.kind) {
      case "response":
        settleResponse(message);
        return;
      case "request":
        handleIncomingRequest(message);
        return;
      case "notification":
        handleNotification(message.method, message.params, line);
        return;
      case "invalid":
        diagnose(message.reason, message.raw);
        return;
    }
  }

  // 读取循环：立即启动。行切分复用 events 的行解码器（半包/粘包/超长防护齐备）
  void (async () => {
    const decoder = createLineDecoder();
    try {
      for await (const chunk of options.readable) {
        for (const line of decoder.push(chunk)) {
          if (closed) {
            return;
          }
          dispatchLine(line);
        }
      }
      for (const line of decoder.flush()) {
        if (closed) {
          return;
        }
        dispatchLine(line);
      }
      close("Agent stdout 已结束");
    } catch (thrown) {
      close(`读取口异常：${thrown instanceof Error ? thrown.message : String(thrown)}`);
    }
  })();

  return {
    get closed() {
      return closed;
    },

    async initialize(initOptions = {}, overrides = {}) {
      const params = {
        protocolVersion: ACP_PROTOCOL_VERSION,
        ...(initOptions.clientInfo === undefined ? {} : { clientInfo: initOptions.clientInfo }),
        ...(initOptions.clientCapabilities === undefined
          ? {}
          : { clientCapabilities: initOptions.clientCapabilities }),
      };
      const result = await sendRequest(
        ACP_AGENT_METHODS.initialize,
        params,
        overrides.timeoutMs ?? defaultTimeoutMs,
      );
      const view = parseInitializeResult(result);
      if (view === undefined) {
        throw new AcpHandshakeError("initialize 响应缺 protocolVersion，不是合法的 ACP Agent");
      }
      if (view.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new AcpHandshakeError(
          `协议版本谈不拢：本端支持 ${ACP_PROTOCOL_VERSION}，Agent 要求 ${view.protocolVersion}（规范：客户端不支持即断开）`,
        );
      }
      return view;
    },

    async authenticate(methodId, overrides = {}) {
      await sendRequest(
        ACP_AGENT_METHODS.authenticate,
        { methodId },
        overrides.timeoutMs ?? defaultTimeoutMs,
      );
    },

    async newSession(params, overrides = {}) {
      const result = await sendRequest(
        ACP_AGENT_METHODS.sessionNew,
        { cwd: params.cwd, mcpServers: params.mcpServers ?? [] },
        overrides.timeoutMs ?? defaultTimeoutMs,
      );
      const view = parseNewSessionResult(result);
      if (view === undefined) {
        throw new AcpHandshakeError("session/new 响应缺 sessionId");
      }
      return view;
    },

    async loadSession(params, overrides = {}) {
      const result = await sendRequest(
        ACP_AGENT_METHODS.sessionLoad,
        {
          sessionId: params.sessionId,
          cwd: params.cwd,
          mcpServers: params.mcpServers ?? [],
        },
        overrides.timeoutMs ?? defaultTimeoutMs,
      );
      return parseLoadSessionResult(result);
    },

    async prompt(params, overrides = {}) {
      const result = await sendRequest(
        ACP_AGENT_METHODS.sessionPrompt,
        { sessionId: params.sessionId, prompt: params.prompt },
        overrides.timeoutMs ?? 0,
      );
      const view = parsePromptResult(result);
      if (view === undefined) {
        throw new AcpHandshakeError("session/prompt 响应缺 stopReason");
      }
      return view;
    },

    cancel(sessionId) {
      if (closed) {
        return;
      }
      writeFrame(buildAcpNotification(ACP_AGENT_METHODS.sessionCancel, { sessionId }));
      // 规范硬性要求：cancel 后该会话所有未决权限请求必须以 cancelled 回执
      for (const [id, inflight] of inflightPermissions) {
        if (inflight.sessionId === sessionId && !inflight.settled) {
          inflight.settled = true;
          inflightPermissions.delete(id);
          respondPermission(id, { kind: "cancelled" });
        }
      }
    },

    close(reason) {
      close(reason);
    },
  };
}
