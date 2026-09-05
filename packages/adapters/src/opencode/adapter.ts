/**
 * OpenCode 适配器（W2.6）：Server（`opencode serve` + HTTP/SSE）接入路径。
 *
 * 战略定位：OpenCode 的 Provider 层能以 openai-compatible 自定义端点接任何
 * `/v1/chat/completions` 服务（docs/adapters/opencode.md §4.2 实证），所以这**一个**
 * 适配器就把 DeepSeek / Qwen / Kimi / GLM / 本地 Ollama 全部变成可用的
 * Planner / Worker。凭证按 Run 经 `ctx.env` 注入（设计文档 §4.3 密钥红线），
 * 配置文件里只留 `{env:VAR}` 引用。
 *
 * 为什么是 Server 而不是 CLI：调研 §2.3 的对比表——CLI `run --format json` 没有
 * 文本增量（源码确认只在 part.time.end emit）、没有权限事件（默认静默自动拒绝），
 * 六项能力里直接少两项。CLI 只作降级兜底，其能力声明见
 * `OPENCODE_CLI_FALLBACK_CAPABILITIES`。
 *
 * 对外仍是 W2.1c 的 turn 模型：常驻 server 是实现细节，一轮 = startTurn(ctx)。
 * 一个 Server 实例服务多轮多会话（复用策略见 server.ts 文件头）。
 */

import type { NativeSessionId } from "@ff-pane/shared";
import type {
  AdapterTurn,
  AdapterTurnContext,
  AgentAdapter,
  PermissionDecision,
} from "../adapter.js";
import type { AdapterCapabilities, AgentEvent, EndEvent, JsonlRecord } from "../events/index.js";
import { toRawEvent } from "../events/index.js";
import type { OpenCodeClient } from "./client.js";
import { createOpenCodeEventMapper, OPENCODE_RUNTIME, parseOpenCodeModel } from "./mapper.js";
import { isSamePath } from "./paths.js";
import type { OpenCodeServer, OpenCodeServerOptions } from "./server.js";
import { createOpenCodeServer } from "./server.js";
import { readSseJsonRecords } from "./sse.js";

/**
 * Server 路径的六项能力（docs/adapters/opencode.md §7 核对表，逐项实测）。
 *
 * 第 3 项的保留意见（调研原文）：工具 completed 态本身不带 diff，本适配器按
 * callID 关联此前 `permission.asked` 的 `metadata.diff` 补齐；权限规则设成
 * allow（不 ask）时就没有这份元数据，此时 file_change 只有路径与类型、diff 缺席
 * ——缺席即缺席，不造假空 diff（events/types.ts FileChangeEvent 注释）。
 */
export const OPENCODE_SERVER_CAPABILITIES: AdapterCapabilities = {
  nativeResume: "yes",
  streaming: "yes",
  fileChangeEvents: "yes",
  commandEvents: "yes",
  permissionForwarding: "yes",
  gracefulCancel: "yes",
};

/**
 * CLI 降级路径（`opencode run --format json`）的能力声明。
 *
 * 本工单不实现该路径；此常量是**降级契约的显式记录**：任何将来以 CLI 方式接
 * OpenCode 的实现（离线环境、serve 起不来的兜底）必须按这一份声明，不得沿用
 * Server 的六项全是——否则 UI 会承诺做不到的事（打字机效果、一键批准）。
 * **T8.5c 注册接入时核实：CLI 降级路径自 T2.6 起从未接线**（capabilities()
 * 恒返回 Server 声明，本常量在 src 无消费方，仅测试钉住两份声明的区别）——
 * 注册按 Server 声明选路，serve 起不来时轮次以 end(failed/crashed) 如实收尾
 * 而非静默换 CLI 路径。
 * 依据调研 §7：流式为"部分"（只有整块 text，无 token 级增量），权限转发为"否"
 * （无事件、默认自动拒绝、`--auto` 自动批准），取消为"部分"（只能杀进程树）。
 */
export const OPENCODE_CLI_FALLBACK_CAPABILITIES: AdapterCapabilities = {
  nativeResume: "yes",
  streaming: "partial",
  fileChangeEvents: "yes",
  commandEvents: "yes",
  permissionForwarding: "no",
  gracefulCancel: "partial",
};

/** 默认 abort 后等待会话转 idle 的时限。 */
export const DEFAULT_ABORT_TIMEOUT_MS = 10_000;
/** 默认 SSE 握手等待时限（等到第一条事件再发提示词，避免漏事件）。 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/** 适配器构造参数。 */
export interface OpenCodeAdapterOptions {
  /** 外部托管的 Server（多个适配器/Profile 共享同一进程时传入）。 */
  readonly server?: OpenCodeServer | undefined;
  /** 自建 Server 的参数（与 `server` 互斥，后者优先）。 */
  readonly serverOptions?: OpenCodeServerOptions | undefined;
  /**
   * `ctx.model` 不含 `/` 时补的 providerID。OpenCode 一律以
   * `<providerID>/<modelID>` 引用模型，而 FF-pane 的 ModelId 是裸模型名。
   */
  readonly providerId?: string | undefined;
  /** OpenCode agent：Planner 用内置 `plan`（默认禁改文件），Worker 用 `build`。 */
  readonly agent?: string | undefined;
  /** 新建会话的标题。 */
  readonly sessionTitle?: string | undefined;
  /** abort 后等待 idle 的时限，默认 10 秒。 */
  readonly abortTimeoutMs?: number | undefined;
  /** SSE 握手等待时限，默认 10 秒。 */
  readonly handshakeTimeoutMs?: number | undefined;
  /** 界面显示名。 */
  readonly displayName?: string | undefined;
}

/** OpenCode 适配器（额外暴露其托管的 Server，供宿主观察状态与关停）。 */
export interface OpenCodeAdapter extends AgentAdapter {
  readonly server: OpenCodeServer;
  /** 关停托管的 Server（宿主退出时调用）。 */
  close(): Promise<void>;
}

interface CancellableTimer {
  readonly promise: Promise<"timeout">;
  cancel(): void;
}

function createTimer(ms: number): CancellableTimer {
  let handle: NodeJS.Timeout | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    handle = setTimeout(() => {
      resolve("timeout");
    }, ms);
  });
  return {
    promise,
    cancel(): void {
      if (handle !== undefined) {
        clearTimeout(handle);
        handle = undefined;
      }
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 创建 OpenCode 适配器。 */
export function createOpenCodeAdapter(options: OpenCodeAdapterOptions = {}): OpenCodeAdapter {
  const server = options.server ?? createOpenCodeServer(options.serverOptions ?? {});
  const abortTimeoutMs = options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

  function startTurn(ctx: AdapterTurnContext): AdapterTurn {
    const controller = new AbortController();
    let client: OpenCodeClient | undefined;
    let sessionId: string | undefined;
    let cancelRequested = false;
    let cancelNote: string | undefined;
    let finished = false;
    let settleReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      settleReady = resolve;
    });
    let escalation: CancellableTimer | undefined;
    let turnTimeout: NodeJS.Timeout | undefined;
    let usageSnapshot: (() => EndEvent["usage"]) | undefined;

    /** 兜底收场：断开 SSE，让事件流以 end 收尾（W2.1c 的"恰好一条 end"约定）。 */
    function detach(): void {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }

    function scheduleEscalation(): void {
      escalation?.cancel();
      const timer = createTimer(abortTimeoutMs);
      escalation = timer;
      void timer.promise.then(() => {
        if (!finished) {
          // abort 已被接受但会话迟迟不转 idle：断掉本轮的 SSE 自行收场，
          // 不动共享的 server（别的轮次还在跑）。
          cancelNote = `abort 后 ${abortTimeoutMs}ms 内未收到 idle，已断开本轮事件流`;
          detach();
        }
      });
    }

    async function requestAbort(note: string): Promise<void> {
      cancelRequested = true;
      cancelNote ??= note;
      const activeClient = client;
      const activeSession = sessionId;
      if (activeClient === undefined || activeSession === undefined) {
        // 会话还没建起来：没有可 abort 的对象，直接断流收场。
        detach();
        return;
      }
      try {
        await activeClient.abort(activeSession, ctx.cwd);
        scheduleEscalation();
      } catch (error) {
        // abort 端点都调不通 = 服务本身失联，重启才是唯一恢复手段。
        cancelNote = `abort 请求失败（${describe(error)}），已断流并重启 opencode serve`;
        detach();
        await server.restart(cancelNote).catch(() => undefined);
      }
    }

    async function* run(): AsyncGenerator<AgentEvent> {
      let acquired = false;
      let iterator: AsyncIterator<JsonlRecord> | undefined;
      /** 尚未被 await 的下一条记录：收场时必须吞掉它的 AbortError，否则是未捕获拒绝。 */
      let pending: Promise<IteratorResult<JsonlRecord>> | undefined;
      try {
        const activeClient = await server.ensureReady({
          ...(ctx.env === undefined ? {} : { env: ctx.env }),
        });
        server.acquire();
        acquired = true;
        client = activeClient;

        const resolved = await resolveSession(activeClient, ctx, options);
        if (typeof resolved !== "string") {
          yield resolved;
          return;
        }
        sessionId = resolved;
        settleReady();

        if (ctx.timeoutMs !== undefined && ctx.timeoutMs > 0) {
          turnTimeout = setTimeout(() => {
            void requestAbort(`本轮超时（${String(ctx.timeoutMs)}ms）`);
          }, ctx.timeoutMs);
        }

        yield {
          kind: "session_start",
          native: { nativeSessionId: resolved as NativeSessionId, cwd: ctx.cwd },
          ...(ctx.model === undefined ? {} : { model: ctx.model }),
        };

        const mapper = createOpenCodeEventMapper({ sessionId: resolved, cwd: ctx.cwd });
        usageSnapshot = mapper.usage;

        const byteStream = await activeClient.subscribeEvents({
          directory: ctx.cwd,
          signal: controller.signal,
        });
        iterator = readSseJsonRecords(byteStream)[Symbol.asyncIterator]();
        pending = iterator.next();

        // 先等 SSE 握手（第一条事件是 server.connected）再发提示词，
        // 否则提示词到得比订阅早，开头的事件会整段丢失。
        const handshake = createTimer(handshakeTimeoutMs);
        try {
          await Promise.race([pending, handshake.promise]);
        } finally {
          handshake.cancel();
        }

        const model = parseOpenCodeModel(ctx.model, options.providerId);
        if (ctx.model !== undefined && model === undefined) {
          yield toRawEvent(
            OPENCODE_RUNTIME,
            { model: ctx.model },
            "模型名不含 providerID 且适配器未配置 providerId，本轮改用 OpenCode 默认模型",
          );
        }
        await activeClient.promptAsync({
          sessionId: resolved,
          text: ctx.prompt,
          directory: ctx.cwd,
          ...(options.agent === undefined ? {} : { agent: options.agent }),
          ...(model === undefined ? {} : { model }),
        });

        for (;;) {
          const next: IteratorResult<JsonlRecord> = await pending;
          if (next.done === true) {
            break;
          }
          pending = iterator.next();
          const record = next.value;
          const events = record.ok
            ? mapper.map(record.value)
            : [toRawEvent(OPENCODE_RUNTIME, record.raw, record.reason)];
          for (const event of events) {
            if (event.kind !== "end") {
              yield event;
              continue;
            }
            yield finalizeEnd(event, cancelRequested, cancelNote);
            return;
          }
        }

        // SSE 断了却没等到终止事件：服务崩了或连接被掐断（含 abort 兜底路径）。
        yield synthesizeEnd(cancelRequested, cancelNote, usageSnapshot?.(), server);
      } catch (error) {
        const usage = usageSnapshot?.();
        yield {
          kind: "end",
          reason: cancelRequested ? "cancelled" : "failed",
          message: cancelRequested ? (cancelNote ?? describe(error)) : describe(error),
          ...(usage === undefined ? {} : { usage }),
        };
      } finally {
        finished = true;
        escalation?.cancel();
        if (turnTimeout !== undefined) {
          clearTimeout(turnTimeout);
        }
        // 先接住悬空的读取再断连：abort 会让它以 AbortError 拒绝，无人接就是未捕获拒绝。
        pending?.catch(() => undefined);
        void iterator?.return?.().catch(() => undefined);
        detach();
        settleReady();
        if (acquired) {
          server.release();
        }
      }
    }

    return {
      events: run(),
      async respondPermission(
        nativeRequestId: string,
        decision: PermissionDecision,
      ): Promise<void> {
        await ready;
        if (client === undefined || sessionId === undefined) {
          throw new Error("本轮尚未建立 OpenCode 会话，无法回执权限请求");
        }
        // FF-pane 的批准只对当前 Run 有效（设计文档 §7），故 allow → once 而非 always。
        await client.respondPermission(
          sessionId,
          nativeRequestId,
          decision === "allow" ? "once" : "reject",
        );
      },
      async cancel(): Promise<void> {
        if (finished) {
          return;
        }
        await requestAbort("用户取消");
      },
    };
  }

  return {
    runtime: OPENCODE_RUNTIME,
    displayName: options.displayName ?? "OpenCode（Server 接入）",
    capabilities: (): AdapterCapabilities => OPENCODE_SERVER_CAPABILITIES,
    startTurn,
    server,
    close: (): Promise<void> => server.close(),
  };
}

/** 取消时把 Runtime 报的 end 改判为 cancelled —— 会话转 idle 本身分不出是完成还是被中断。 */
function finalizeEnd(
  event: EndEvent,
  cancelRequested: boolean,
  note: string | undefined,
): EndEvent {
  if (!cancelRequested) {
    return event;
  }
  return {
    ...event,
    reason: "cancelled",
    ...(note === undefined ? {} : { message: note }),
  };
}

function synthesizeEnd(
  cancelRequested: boolean,
  note: string | undefined,
  usage: EndEvent["usage"],
  server: OpenCodeServer,
): EndEvent {
  const status = server.status();
  const message = cancelRequested
    ? (note ?? "事件流在取消后中断")
    : `SSE 事件流中断且未收到终止事件${status.lastError === undefined ? "" : `：${status.lastError}`}`;
  const exitCode = status.lastExit?.exitCode;
  return {
    kind: "end",
    reason: cancelRequested ? "cancelled" : "crashed",
    message,
    ...(usage === undefined ? {} : { usage }),
    ...(exitCode === undefined || exitCode === null ? {} : { exitCode }),
  };
}

/**
 * 建会话或校验 resume 绑定。成功返回 sessionID，失败返回一条 end 事件
 *（startTurn 是同步接口，失败只能经事件流表达，见 adapter.ts 接口注释）。
 */
async function resolveSession(
  client: OpenCodeClient,
  ctx: AdapterTurnContext,
  options: OpenCodeAdapterOptions,
): Promise<string | EndEvent> {
  if (ctx.resume === undefined) {
    const created = await client.createSession({
      directory: ctx.cwd,
      ...(options.sessionTitle === undefined ? {} : { title: options.sessionTitle }),
      ...(options.agent === undefined ? {} : { agent: options.agent }),
    });
    return created.id;
  }

  if (!isSamePath(ctx.resume.cwd, ctx.cwd)) {
    return {
      kind: "end",
      reason: "failed",
      message: `原生会话绑定的 cwd（${ctx.resume.cwd}）与本轮 cwd（${ctx.cwd}）不一致，拒绝恢复`,
    };
  }
  const session = await client.getSession(ctx.resume.nativeSessionId, ctx.cwd);
  if (session.directory !== undefined && !isSamePath(session.directory, ctx.cwd)) {
    return {
      kind: "end",
      reason: "failed",
      message: `会话 ${session.id} 绑定的目录是 ${session.directory}，与本轮 cwd（${ctx.cwd}）不一致`,
    };
  }
  return session.id;
}
