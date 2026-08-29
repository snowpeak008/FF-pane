/**
 * Agent CLI 子进程管理层的公共类型（W2.1a）。
 *
 * 本层只负责"把 CLI 跑起来、把字节原样交出去、能可靠地整树杀掉"，不认识任何
 * 具体 CLI 的协议：行切分与 JSONL 解析归 W2.1b（events/），事件语义归 W2.1c
 * 及各适配器工单。
 */

// 本包 tsconfig 未声明 "types"（@types/node 由仓库根 hoist 提供），故以三斜线
// 指令显式纳入 node 类型；与 auth-probe/executor.ts 同样处理。
/// <reference types="node" />

import type { Writable } from "node:stream";

/**
 * 子进程 stdin 形态：
 * - closed：不给 stdin（stdio: "ignore"）。Codex 等 CLI 在 stdin 为管道且不关闭时
 *   会一直等输入或把管道内容附进提示词（docs/adapters/codex.md §7.2）。
 * - pipe：保留写入端，供需要 stdin 协议的 CLI 使用（如 Claude Code 的
 *   `--permission-prompt-tool stdio` 控制请求，docs/adapters/claude-code.md §5）。
 */
export type AgentStdinMode = "closed" | "pipe";

/** spawnAgentProcess 的输入规格。 */
export interface AgentProcessSpec {
  /** 命令名或路径。Windows 下自行做 PATH × PATHEXT 解析并处理 .cmd 垫片。 */
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  /**
   * 显式注入的环境变量。优先级高于清洗：注入表里出现的名字即使命中
   * API_KEY_ENV_PATTERNS 也会保留（Run 级密钥注入靠这条路径）。
   */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** 默认 "closed"。 */
  readonly stdin?: AgentStdinMode | undefined;
  /** 超时毫秒：到期自动树杀，结束方式为 "timeout"。缺省或 <= 0 表示不限时。 */
  readonly timeoutMs?: number | undefined;
  /** 是否剥离 API key 类环境变量，默认 true。 */
  readonly stripApiKeyEnv?: boolean | undefined;
  /** 清洗与注入的基底环境，默认 process.env（测试可注入伪环境）。 */
  readonly baseEnv?: NodeJS.ProcessEnv | undefined;
  /** 单条流的排队字节上限，超过即对管道施加背压（pause）。默认 4 MiB。 */
  readonly streamHighWaterMark?: number | undefined;
}

/**
 * 进程结束方式：
 * - exited        自然退出（含非零退出码）；
 * - killed        经 kill() 主动终止，或收到外部信号；
 * - timeout       spec.timeoutMs 到期被本层树杀；
 * - spawn-failed  根本没起来（ENOENT / 权限 / PATH 未命中），不抛裸异常。
 */
export type AgentProcessEndKind = "exited" | "killed" | "timeout" | "spawn-failed";

/** 进程终局。exitPromise 永不 reject，一切失败都表达为本结构。 */
export interface AgentProcessExit {
  readonly kind: AgentProcessEndKind;
  /** 退出码；被信号杀死或 spawn 失败时为 null。Windows 下 taskkill /F 通常给 1。 */
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** 人类可读的失败原因（spawn 失败或 spawn 后的进程级错误），无则 null。 */
  readonly error: string | null;
  /** errno 码（"ENOENT" 等），无则 null。 */
  readonly errorCode: string | null;
}

/**
 * 运行中的进程句柄。
 *
 * 流的约定（W2.1b 直接消费）：
 * - stdout/stderr 逐块产出 Buffer，**保持 spawn 时 'data' 事件的原始分块**，
 *   不合并、不重排、不丢字节；行边界可能落在任意块中间，切行是消费方的事。
 * - 每条流只允许一个消费者（单 for-await 循环）。
 * - 流内部有背压：排队字节超过 streamHighWaterMark 即 pause 管道，消费方追上后
 *   自动 resume。**因此两条流都必须被消费（或调用 kill()）**，否则大量输出的
 *   进程会被背压挡住而迟迟不退出。
 */
export interface AgentProcessHandle {
  /** spawn 失败时为 undefined。 */
  readonly pid: number | undefined;
  readonly stdout: AsyncIterable<Buffer>;
  readonly stderr: AsyncIterable<Buffer>;
  /** stdin 模式为 "pipe" 时的写入端，否则 null。 */
  readonly stdin: Writable | null;
  readonly exitPromise: Promise<AgentProcessExit>;
  /** 解析到的 CLI 可执行文件（Windows 垫片场景为 .cmd 本身），未解析出则为原始 command。 */
  readonly resolvedCommand: string;
  /** 是否经 cmd.exe 垫片执行（Windows .cmd/.bat）。 */
  readonly viaCmdShim: boolean;
  /** 被清洗掉的环境变量名（已排序），供 Run 日志审计。 */
  readonly strippedEnvNames: readonly string[];
  /** 树杀并等待退出；进程已退出时幂等无害。返回终局（与 exitPromise 同一结果）。 */
  kill(): Promise<AgentProcessExit>;
}
