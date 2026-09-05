/**
 * `opencode serve` 子进程生命周期管理（W2.6）。
 *
 * 为什么适配器要自己托管一个常驻进程：调研结论（docs/adapters/opencode.md §2.3）
 * 是 Server 是唯一能同时拿到六项能力的路径——CLI `run --format json` 既没有
 * 文本增量也没有权限事件（默认静默自动拒绝）。代价就是这个模块：端口、健康
 * 检查、崩溃检测、复用与关闭策略都得自己管。
 *
 * ## 复用与关闭策略（本工单的设计决策）
 * - **一个实例服务多轮多会话**：冷启动实测 3–5 秒，每轮重启不可接受。turn 开始
 *   时 `ensureReady()` + `acquire()`，turn 结束时 `release()`；引用计数归零后
 *   **默认继续存活**（`idleShutdownMs: 0`），等宿主显式 `close()`（退出应用/切换
 *   Profile）。设 `idleShutdownMs > 0` 则空闲到期自动关停。
 * - **env 指纹绑定**：Provider 凭证只能在 spawn 时注入（OpenCode 从环境变量吸收
 *   Provider，见 §4.3），进程起来后无法按轮改。故每个 Server 实例绑定一份 env
 *   指纹（sha256，不含明文）：指纹变了且当前无活跃轮次 → 自动重启换配置；有活跃
 *   轮次 → 抛错要求宿主为另一份配置另建适配器实例，绝不偷偷杀掉别人的 Run。
 * - **崩溃**：`exitPromise` 落地即置 `crashed` 并记录退出码与最近输出；进行中的
 *   turn 由 SSE 断流兜底收 end，下一次 `ensureReady()` 自动重启。
 *
 * ## 端口策略
 * 默认 `--port 0`：由操作系统分配空闲端口，再从 stdout 的
 * `opencode server listening on http://127.0.0.1:<port>` 解析真实地址（1.18.25
 * 实测）。这比"自己找空闲端口再传给子进程"少一个 TOCTOU 竞态窗口。显式指定
 * `port` 时仍优先采信 stdout 公告，公告缺席（版本改了措辞）才退回配置值。
 *
 * ## 与 W2.1a 的约定
 * - **不设 `timeoutMs`**：常驻服务没有"该结束了"的时刻，超时树杀会把正跑着的
 *   Run 一起带走。收场一律走 `kill()`（内部 taskkill /T，解决 npm wrapper 的
 *   PID ≠ 实际进程问题，见 §8.2 坑 3）。
 * - stdout/stderr **必须持续消费**，否则背压会把服务卡死；两条流都进环形缓冲，
 *   只留最近若干行供诊断。
 */

/// <reference types="node" />

import { createHash, randomBytes } from "node:crypto";
import { decodeLines } from "../events/index.js";
import type { AgentProcessExit, AgentProcessHandle } from "../process/index.js";
import { spawnAgentProcess } from "../process/index.js";
import type { FetchLike, OpenCodeClient } from "./client.js";
import { createOpenCodeClient } from "./client.js";

/** Server 状态。 */
export type OpenCodeServerState = "stopped" | "starting" | "ready" | "crashed" | "closed";

/** 对外暴露的 Server 状态快照。 */
export interface OpenCodeServerStatus {
  readonly state: OpenCodeServerState;
  /** ready 时的服务地址。 */
  readonly baseUrl?: string;
  readonly pid?: number;
  /** `GET /global/health` 报告的 OpenCode 版本 —— 版本漂移排查的第一手依据。 */
  readonly version?: string;
  /** 当前活跃轮次数（引用计数）。 */
  readonly activeTurns: number;
  /** 累计重启次数（含崩溃后重启与换配置重启）。 */
  readonly restarts: number;
  /** 最近一次失败/崩溃说明。 */
  readonly lastError?: string;
  /** 最近一次子进程终局（崩溃或主动关停）。 */
  readonly lastExit?: AgentProcessExit;
  /** 被清洗掉的环境变量名（W2.1a 审计用，不含值）。 */
  readonly strippedEnvNames: readonly string[];
  /** 子进程最近输出（stdout/stderr 合并，含前缀标注），诊断用。 */
  readonly recentOutput: readonly string[];
}

/** 启动一轮/一个 Server 所需的运行期配置（env 指纹的来源）。 */
export interface OpenCodeServerRequest {
  /** Run 级注入环境变量（Provider 密钥、OPENCODE_CONFIG_CONTENT 等）。 */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/** Server 构造参数。 */
export interface OpenCodeServerOptions {
  /** 可执行文件名，默认 `opencode`（Windows 下由 W2.1a 解析 .cmd 垫片）。 */
  readonly command?: string | undefined;
  /**
   * 插在 `serve` 之前的参数。用于"命令本身不是 opencode 可执行文件"的启动方式，
   * 如 `node <入口>`、`npx -y opencode-ai`、`bun x opencode`。
   */
  readonly leadingArgs?: readonly string[] | undefined;
  /** 追加在 `serve` 参数之后的额外参数。 */
  readonly extraArgs?: readonly string[] | undefined;
  /** 监听地址，默认 `127.0.0.1`（只听回环）。 */
  readonly hostname?: string | undefined;
  /** 监听端口，默认 0（由操作系统分配）。 */
  readonly port?: number | undefined;
  /** 子进程工作目录；缺席则继承宿主。会话的目录由请求的 `directory` 参数决定。 */
  readonly cwd?: string | undefined;
  /** 固定注入的环境变量（与每轮的 request.env 合并，后者优先）。 */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** 是否清洗 API key 类环境变量，默认 true（见 W2.1a env.ts 的动机）。 */
  readonly stripApiKeyEnv?: boolean | undefined;
  /** 清洗与注入的基底环境，默认 process.env。 */
  readonly baseEnv?: NodeJS.ProcessEnv | undefined;
  /**
   * `OPENCODE_SERVER_PASSWORD`。缺席 = 每次启动随机生成（默认，回环也不裸奔）；
   * 显式传 null = 不设密码（服务会打印 "server is unsecured" 警告）。
   */
  readonly password?: string | null | undefined;
  /** 从 spawn 到健康检查通过的总时限，默认 60 秒（首跑要拉 models.dev 目录）。 */
  readonly readyTimeoutMs?: number | undefined;
  /** 健康检查轮询间隔，默认 250 毫秒。 */
  readonly healthIntervalMs?: number | undefined;
  /** 普通 HTTP 请求超时，默认 30 秒。 */
  readonly requestTimeoutMs?: number | undefined;
  /** 引用计数归零后自动关停的空闲时长；0（默认）= 不自动关停。 */
  readonly idleShutdownMs?: number | undefined;
  /** 诊断环形缓冲保留的输出行数，默认 100。 */
  readonly outputLogLimit?: number | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  /** 状态变化回调（宿主可据此在 UI 上显示 Runtime 健康度）。 */
  readonly onStateChange?: ((status: OpenCodeServerStatus) => void) | undefined;
}

/** 托管中的 OpenCode Server。 */
export interface OpenCodeServer {
  status(): OpenCodeServerStatus;
  /** 确保服务就绪并返回客户端；并发调用共享同一次启动。 */
  ensureReady(request?: OpenCodeServerRequest): Promise<OpenCodeClient>;
  /** 引用计数 +1（turn 开始）。 */
  acquire(): void;
  /** 引用计数 -1（turn 结束）；归零且设了 idleShutdownMs 则排定自动关停。 */
  release(): void;
  /** 杀掉并重启（崩溃恢复 / abort 无响应时的兜底）。 */
  restart(reason: string): Promise<OpenCodeClient>;
  /** 关停并释放；幂等。 */
  close(): Promise<void>;
}

/** Server 生命周期层的失败。 */
export class OpenCodeServerError extends Error {
  override readonly name = "OpenCodeServerError";
  /** 失败时的状态快照（含最近输出），排障用。 */
  readonly status: OpenCodeServerStatus | undefined;

  constructor(message: string, status?: OpenCodeServerStatus) {
    super(message);
    this.status = status;
  }
}

/** 默认健康检查轮询间隔。 */
export const DEFAULT_HEALTH_INTERVAL_MS = 250;
/** 默认就绪时限。 */
export const DEFAULT_READY_TIMEOUT_MS = 60_000;

/** stdout 的监听地址公告（1.18.25：`opencode server listening on http://127.0.0.1:4096`）。 */
const LISTENING_URL_PATTERN = /listening on\s+(https?:\/\/\S+)/i;
const ANY_URL_PATTERN = /(https?:\/\/[^\s"']+)/;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 可取消的定时器 promise：竞速用完必须 cancel，否则悬挂的定时器会拖住进程退出。 */
function createTimeoutSignal(ms: number): { readonly promise: Promise<"timeout">; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      resolve("timeout");
    }, ms);
  });
  return {
    promise,
    cancel(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

/** env 指纹：只暴露摘要，绝不保留明文（密钥红线，adapter.ts §密钥红线）。 */
function fingerprintEnv(env: Readonly<Record<string, string>> | undefined, cwd?: string): string {
  const hash = createHash("sha256");
  hash.update(cwd ?? "");
  for (const [key, value] of Object.entries(env ?? {}).sort((a, b) => a[0].localeCompare(b[0]))) {
    hash.update(`\u0000${key}\u0000${value}`);
  }
  return hash.digest("hex");
}

interface RunningServer {
  readonly handle: AgentProcessHandle;
  readonly client: OpenCodeClient;
  readonly baseUrl: string;
  readonly fingerprint: string;
}

/** 创建（尚未启动的）Server 托管器。 */
export function createOpenCodeServer(options: OpenCodeServerOptions = {}): OpenCodeServer {
  const command = options.command ?? "opencode";
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 0;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const healthIntervalMs = options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
  const idleShutdownMs = options.idleShutdownMs ?? 0;
  const outputLogLimit = options.outputLogLimit ?? 100;

  let state: OpenCodeServerState = "stopped";
  let running: RunningServer | undefined;
  let startPromise: Promise<OpenCodeClient> | undefined;
  let version: string | undefined;
  let lastError: string | undefined;
  let lastExit: AgentProcessExit | undefined;
  let strippedEnvNames: readonly string[] = [];
  let activeTurns = 0;
  let restarts = 0;
  let closing = false;
  let idleTimer: NodeJS.Timeout | undefined;
  /** 最近一次 ensureReady 的运行期配置：重启（崩溃恢复 / abort 兜底）要原样复现。 */
  let lastRequest: OpenCodeServerRequest = {};
  const recentOutput: string[] = [];

  function record(prefix: string, line: string): void {
    if (line === "") {
      return;
    }
    recentOutput.push(`${prefix} ${line}`);
    while (recentOutput.length > outputLogLimit) {
      recentOutput.shift();
    }
  }

  function snapshot(): OpenCodeServerStatus {
    return {
      state,
      ...(running === undefined ? {} : { baseUrl: running.baseUrl }),
      ...(running?.handle.pid === undefined ? {} : { pid: running.handle.pid }),
      ...(version === undefined ? {} : { version }),
      activeTurns,
      restarts,
      ...(lastError === undefined ? {} : { lastError }),
      ...(lastExit === undefined ? {} : { lastExit }),
      strippedEnvNames,
      recentOutput: [...recentOutput],
    };
  }

  function setState(next: OpenCodeServerState): void {
    if (state === next) {
      return;
    }
    state = next;
    options.onStateChange?.(snapshot());
  }

  async function pump(
    stream: AsyncIterable<Buffer>,
    prefix: string,
    onLine?: (line: string) => void,
  ): Promise<void> {
    try {
      for await (const line of decodeLines(stream)) {
        record(prefix, line);
        onLine?.(line);
      }
    } catch (error) {
      record(prefix, `[流中断] ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function launch(request: OpenCodeServerRequest): Promise<OpenCodeClient> {
    const password =
      options.password === null ? undefined : (options.password ?? randomBytes(24).toString("hex"));
    const env: Record<string, string> = {
      // 版本漂移第一道闸：禁掉自动更新，否则事件 schema 会在用户无感知下变化（R3）。
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      NO_COLOR: "1",
      ...options.env,
      ...request.env,
      ...(password === undefined ? {} : { OPENCODE_SERVER_PASSWORD: password }),
    };
    const fingerprint = fingerprintEnv({ ...options.env, ...request.env }, options.cwd);

    setState("starting");
    lastError = undefined;
    lastExit = undefined;
    version = undefined;

    const handle = spawnAgentProcess({
      command,
      args: [
        ...(options.leadingArgs ?? []),
        "serve",
        "--port",
        String(port),
        "--hostname",
        hostname,
        ...(options.extraArgs ?? []),
      ],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env,
      stdin: "closed",
      // 有意不设 timeoutMs：常驻服务不该被本层超时树杀（见文件头"与 W2.1a 的约定"）。
      ...(options.stripApiKeyEnv === undefined ? {} : { stripApiKeyEnv: options.stripApiKeyEnv }),
      ...(options.baseEnv === undefined ? {} : { baseEnv: options.baseEnv }),
    });
    strippedEnvNames = handle.strippedEnvNames;

    let announceUrl: ((url: string) => void) | undefined;
    const announced = new Promise<string>((resolve) => {
      announceUrl = resolve;
    });
    const stdoutDone = pump(handle.stdout, "[out]", (line) => {
      const match = LISTENING_URL_PATTERN.exec(line) ?? ANY_URL_PATTERN.exec(line);
      if (match?.[1] !== undefined) {
        announceUrl?.(match[1].replace(/[.,]$/, ""));
      }
    });
    const stderrDone = pump(handle.stderr, "[err]");

    const exited = handle.exitPromise.then((exit) => {
      lastExit = exit;
      if (!closing) {
        lastError = `opencode serve 进程退出（${exit.kind}, code=${exit.exitCode ?? "null"}）`;
        running = undefined;
        startPromise = undefined;
        setState("crashed");
      }
      return exit;
    });
    // 两条流始终被消费；进程收场后即结束，无需额外等待。
    void stdoutDone;
    void stderrDone;

    const deadline = Date.now() + readyTimeoutMs;
    const baseUrl = await resolveBaseUrl(announced, exited, deadline);
    const client = createOpenCodeClient({
      baseUrl,
      ...(password === undefined ? {} : { password }),
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });

    await waitHealthy(client, handle, deadline);
    running = { handle, client, baseUrl, fingerprint };
    setState("ready");
    return client;
  }

  async function resolveBaseUrl(
    announced: Promise<string>,
    exited: Promise<AgentProcessExit>,
    deadline: number,
  ): Promise<string> {
    const fallback = port > 0 ? `http://${hostname}:${port}` : undefined;
    const timeout = createTimeoutSignal(Math.max(0, deadline - Date.now()));
    const death = exited.then(() => "\u0000exit" as const);
    let result: string;
    try {
      result = await Promise.race([announced, death, timeout.promise]);
    } finally {
      timeout.cancel();
    }
    if (result === "\u0000exit") {
      throw new OpenCodeServerError(
        `opencode serve 启动即退出：${lastError ?? "未知原因"}`,
        snapshot(),
      );
    }
    if (result !== "timeout") {
      return result.replace(/\/+$/, "");
    }
    if (fallback !== undefined) {
      // 公告措辞变了但端口是我们指定的，仍可尝试。
      return fallback;
    }
    throw new OpenCodeServerError(
      "opencode serve 未在时限内公告监听地址（--port 0 时地址只能从 stdout 获得）",
      snapshot(),
    );
  }

  async function waitHealthy(
    client: OpenCodeClient,
    handle: AgentProcessHandle,
    deadline: number,
  ): Promise<void> {
    let lastFailure = "尚未尝试";
    for (;;) {
      if (lastExit !== undefined) {
        throw new OpenCodeServerError(
          `健康检查期间 opencode serve 已退出：${lastError ?? "未知原因"}`,
          snapshot(),
        );
      }
      try {
        const health = await client.health();
        if (health.healthy) {
          version = health.version;
          return;
        }
        lastFailure = `/global/health 返回 healthy=false`;
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
      }
      if (Date.now() >= deadline) {
        lastError = lastFailure;
        await handle.kill();
        throw new OpenCodeServerError(
          `opencode serve 健康检查超时（${client.baseUrl}）：${lastFailure}`,
          snapshot(),
        );
      }
      await delay(healthIntervalMs);
    }
  }

  async function stop(nextState: OpenCodeServerState): Promise<void> {
    clearIdleTimer();
    const current = running;
    running = undefined;
    startPromise = undefined;
    version = undefined;
    closing = true;
    try {
      if (current !== undefined) {
        await current.handle.kill();
      }
    } finally {
      closing = false;
      setState(nextState);
    }
  }

  function clearIdleTimer(): void {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  }

  function scheduleIdleShutdown(): void {
    if (idleShutdownMs <= 0 || activeTurns > 0 || running === undefined) {
      return;
    }
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (activeTurns === 0) {
        void stop("stopped");
      }
    }, idleShutdownMs);
    idleTimer.unref();
  }

  function start(request: OpenCodeServerRequest): Promise<OpenCodeClient> {
    lastRequest = request;
    const pending = launch(request).catch((error: unknown) => {
      startPromise = undefined;
      running = undefined;
      lastError = error instanceof Error ? error.message : String(error);
      setState("crashed");
      throw error;
    });
    startPromise = pending;
    return pending;
  }

  return {
    status: snapshot,

    acquire(): void {
      activeTurns += 1;
      clearIdleTimer();
    },

    release(): void {
      activeTurns = Math.max(0, activeTurns - 1);
      scheduleIdleShutdown();
    },

    async ensureReady(request: OpenCodeServerRequest = {}): Promise<OpenCodeClient> {
      if (state === "closed") {
        throw new OpenCodeServerError("Server 已关闭，请新建实例", snapshot());
      }
      clearIdleTimer();
      const wanted = fingerprintEnv({ ...options.env, ...request.env }, options.cwd);
      if (running !== undefined) {
        if (running.fingerprint === wanted) {
          return running.client;
        }
        if (activeTurns > 0) {
          throw new OpenCodeServerError(
            "本轮的环境变量配置与运行中的 opencode serve 不一致，且仍有活跃轮次：" +
              "OpenCode 只在 spawn 时吸收 Provider 环境变量，请为另一份配置单建适配器实例",
            snapshot(),
          );
        }
        restarts += 1;
        await stop("stopped");
      }
      if (startPromise !== undefined) {
        return startPromise;
      }
      return start(request);
    },

    async restart(reason: string): Promise<OpenCodeClient> {
      if (state === "closed") {
        throw new OpenCodeServerError("Server 已关闭，请新建实例", snapshot());
      }
      restarts += 1;
      await stop("stopped");
      lastError = reason;
      return start(lastRequest);
    },

    async close(): Promise<void> {
      if (state === "closed") {
        return;
      }
      // 启动进行中（T8.5c 退出收敛核实）：先等 launch 落定再关。直接 stop 只会清掉
      // startPromise 引用，进行中的 launch 稍后完成时会把 running/ready 写回来——
      // 进程从 close 漏出。等落定后：成功则 running 已就位、下方 stop 收掉进程；
      // 失败则 launch 自行清理，stop 只负责置终态。
      const pending = startPromise;
      if (pending !== undefined) {
        await pending.catch(() => undefined);
      }
      await stop("closed");
    },
  };
}
