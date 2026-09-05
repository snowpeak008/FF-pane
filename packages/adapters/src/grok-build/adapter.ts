/**
 * Grok Build 适配器（T7.3 headless；T8.5b 增 ACP 首选路径）。
 *
 * ## 双模式与选路（T8.5b 决策，两案对比见 grok-build.md §7.4）
 *
 * - **ACP 模式（首选）**：spawn `grok agent stdio`，经 T8.5a 的 AcpConnection 走
 *   双工通道（acp-turn.ts）。相对 headless 的三点实质收益（全部 1.0.13 真机实测）：
 *   权限请求真转发（session/request_permission → FF-pane 权限层逐次裁决，不再
 *   `--always-approve` 全放行）、优雅取消（session/cancel 协议级收工，树杀只兜底）、
 *   sessionId 开轮即得（headless 只在 end 给，中断轮拿不到续接凭据——§7.3 坑 5
 *   在 ACP 模式不存在）。
 * - **headless streaming-json（降级保留）**：`grok agent stdio` 子命令不存在
 *   （旧版 grok）或握手失败时退回现行模式，行为与 T7.3 交付逐字不变。
 * - **检测方式与缓存口径**：不做 version 探测（版本号 ↛ 子命令存在性，且多一次
 *   spawn）；首轮直接试 ACP，**initialize 握手失败即降级**（此时零事件已发出、
 *   进程已收，本轮当场以 headless 重跑），结果缓存在适配器实例上——同实例后续
 *   轮次不再重试 ACP。缓存随实例生命周期（进程内存，不落盘）：grok 升级后重启
 *   工作台即重新探测。
 * - 两模式的会话**互通**（1.0.13 真机三向实测：ACP session/new → headless `-r`
 *   → ACP session/load，同一 sessionId 全程有效）——降级不损失续接。
 *
 * ## 能力声明的条件式（T7.3a/T7.3b 纪律：与实测一致，不支持照实报 no）
 *
 * capabilities() 按**当前选路**返回：ACP 路径 permissionForwarding/gracefulCancel
 * 双 yes（真机实测：审批往返、session/cancel 优雅落定均成立）；headless 路径维持
 * no/partial 原值。auto 模式在首轮探测前按 ACP 报（乐观值）——探测失败的那一轮
 * 事后看声明偏高，但该声明的仓内唯一消费方是编排器的 nativeResume 门槛（两模式
 * 同为 yes，不受影响），UI 无消费方；首轮之后声明即与实测选路一致。
 *
 * ## headless 模式的四个实测结论（原 T7.3 注释，继续成立）
 *
 * - **提示词写临时文件**：官方明写 headless 不读管道 stdin；文件落系统临时目录，
 *   轮次结束即删；
 * - **必开 `--always-approve`**：否则每个工具都以「User cancelled」落地而退出码
 *   仍是 0（§7.3 坑 1）。安全由 FF-pane 权限层承担（W2.7）；
 * - **resume 绑定 cwd**：会话按 cwd 分桶，不一致启动前快速失败（两模式同规）；
 * - **不支持 MCP 注入**：无逐轮注入参数，ctx.mcpServers 被忽略（§6）。
 *   ACP 模式的 session/new 虽收 mcpServers 参数，本单不接（形状与注入语义未实测，
 *   声明保持如实）。
 */

/// <reference types="node" />

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterTurn,
  AdapterTurnContext,
  AgentAdapter,
  PermissionDecision,
} from "../adapter.js";
import type { AdapterCapabilities, AgentEvent } from "../events/index.js";
import { readJsonlStream, toRawEvent } from "../events/index.js";
import type { AgentProcessHandle } from "../process/index.js";
import { spawnAgentProcess } from "../process/index.js";
import type { GrokAcpAttempt } from "./acp-turn.js";
import { GrokAcpProtocolError, startGrokAcpAttempt } from "./acp-turn.js";
import type { GrokPermissionMode } from "./command.js";
import {
  buildGrokAcpArgs,
  buildGrokArgs,
  DEFAULT_GROK_COMMAND,
  GROK_BUILD_RUNTIME,
} from "./command.js";
import { createGrokEventMapper } from "./mapper.js";
import type { SpawnAgentProcessFn } from "./turn-support.js";
import {
  failFastTurn,
  readStderrTail,
  resolveGrokCommand,
  resumeViolationOf,
} from "./turn-support.js";

/**
 * headless 模式六项能力声明，逐项对齐 docs/adapters/grok-build.md §6 的核对表：
 * 1. 原生会话恢复 yes —— `-r <session_id>` 真机验证：sessionId 不变、上下文完整回填；
 * 2. 流式输出 yes —— `text` 事件是真增量（实测一句话被切成两片投递）；
 * 3. 文件修改事件 yes —— `content[].type="diff"` 直接给 oldText/newText 全文；
 * 4. 命令执行事件 yes —— rawOutput 含退出码、命令、cwd、截断/超时标志与输出；
 * 5. 权限请求转发 no —— headless 是单向流，无审批回执通道；
 * 6. 中途取消 partial —— 无优雅协议，只能杀进程树，且无终止事件需自判。
 */
export const GROK_BUILD_CAPABILITIES: AdapterCapabilities = {
  nativeResume: "yes",
  streaming: "yes",
  fileChangeEvents: "yes",
  commandEvents: "yes",
  permissionForwarding: "no",
  gracefulCancel: "partial",
};

/**
 * ACP 模式六项能力声明（T8.5b，1.0.13 真机实测 + fixtures real-acp-*.jsonl）：
 * 1~4 与 headless 同源（同一份事件词汇的 ACP 原生形态，diff/rawOutput 逐字段核对）；
 * 5. 权限请求转发 **yes** —— session/request_permission 请求/回执闭环实测
 *    （selected 放行工具落地、reject 后 grok 报「User rejected the execution」）；
 * 6. 中途取消 **yes** —— session/cancel 通知后 grok 自己收工具、prompt 以
 *    stopReason=cancelled 优雅落定（实测），树杀仅作宽限期兜底。
 */
export const GROK_BUILD_ACP_CAPABILITIES: AdapterCapabilities = {
  nativeResume: "yes",
  streaming: "yes",
  fileChangeEvents: "yes",
  commandEvents: "yes",
  permissionForwarding: "yes",
  gracefulCancel: "yes",
};

/** 传输模式：auto = ACP 首选、握手失败降级 headless 并缓存（模块头）。 */
export const GROK_TRANSPORTS = ["auto", "acp", "streaming-json"] as const;

/** 传输模式。 */
export type GrokTransport = (typeof GROK_TRANSPORTS)[number];

/** createGrokBuildAdapter 的可选项。 */
export interface GrokBuildAdapterOptions {
  /** grok 可执行文件名或路径，默认 "grok"。 */
  readonly command?: string | undefined;
  /**
   * 传输模式，默认 "auto"（ACP 首选 + 降级缓存）。显式 "acp" 不降级（握手失败
   * 即本轮失败——调用方点名要的路径不该被静默换掉）；显式 "streaming-json"
   * 恒走现行 headless。
   */
  readonly transport?: GrokTransport | undefined;
  /** 权限模式（仅 headless 路径消费），默认 always-approve（论证见 command.ts）。 */
  readonly permissionMode?: GrokPermissionMode | undefined;
  /** 是否禁止子 Agent（仅 headless；ACP 路径靠权限桥 fail-closed 兜底），默认 true。 */
  readonly noSubagents?: boolean | undefined;
  /** 关闭联网搜索与抓取（仅 headless；agent 层无此参数）。 */
  readonly disableWebSearch?: boolean | undefined;
  /** `--allow` 规则（仅 headless）。 */
  readonly allowRules?: readonly string[] | undefined;
  /** `--deny` 规则（仅 headless；纵深防御，非唯一防线）。 */
  readonly denyRules?: readonly string[] | undefined;
  /** `--tools` 工具白名单（仅 headless）。 */
  readonly tools?: readonly string[] | undefined;
  /** `--disallowed-tools` 工具黑名单（仅 headless）。 */
  readonly disallowedTools?: readonly string[] | undefined;
  /** `--max-turns` 成本护栏（仅 headless；agent 层无此参数）。 */
  readonly maxTurns?: number | undefined;
  /** `--reasoning-effort` 推理强度（两模式都消费，agent 层同名参数）。 */
  readonly reasoningEffort?: string | undefined;
  /**
   * 覆盖 `GROK_HOME`（配置 / 认证 / 会话目录）。
   * 缺省沿用用户的 `~/.grok`——那里有他的登录态与会话历史，重定向会让
   * `cli_login` 类 Provider 立刻失效（取舍详见 grok-build.md §7.4）。
   */
  readonly grokHome?: string | undefined;
  /** 提示词临时文件的落点目录（仅 headless），默认系统临时目录（单测注入用）。 */
  readonly promptDir?: string | undefined;
  /** 原样追加的 CLI 参数（仅 headless，逃生门）。 */
  readonly extraArgs?: readonly string[] | undefined;
  /** 是否剥离子进程里的 API key 类环境变量，默认 true（见 process/env.ts）。 */
  readonly stripApiKeyEnv?: boolean | undefined;
  /** 子进程启动函数，默认 W2.1a 的 spawnAgentProcess（测试注入假 CLI）。 */
  readonly spawn?: SpawnAgentProcessFn | undefined;
  /** ACP initialize 握手超时毫秒（测试注入；缺省协议层控制面 30 s）。 */
  readonly acpHandshakeTimeoutMs?: number | undefined;
  /** ACP 优雅取消宽限毫秒（测试注入；缺省 GROK_ACP_CANCEL_GRACE_MS）。 */
  readonly acpCancelGraceMs?: number | undefined;
}

/** Grok 的一轮：在统一 AdapterTurn 之上多一个"事件流外"的返回值。 */
export interface GrokBuildTurn extends AdapterTurn {
  /** 本轮实际执行的命令行（可执行文件 + 参数），供 Run 日志与排障。 */
  readonly commandLine: readonly string[];
}

/** Grok Build 适配器（startTurn 返回收窄到 GrokBuildTurn）。 */
export interface GrokBuildAdapter extends AgentAdapter {
  startTurn(ctx: AdapterTurnContext): GrokBuildTurn;
}

/** 提示词临时文件名：随机后缀，避免并发轮次互相覆盖。 */
function promptFilePath(dir: string): string {
  return path.join(dir, `ffpane-grok-prompt-${randomBytes(8).toString("hex")}.txt`);
}

/** 两模式共用的子进程环境（更新检查连派生进程一起关掉，grok-build.md §1.2）。 */
function grokEnv(
  options: GrokBuildAdapterOptions,
  ctx: AdapterTurnContext,
): Record<string, string> {
  return {
    ...ctx.env,
    GROK_DISABLE_AUTOUPDATER: "1",
    ...(options.grokHome === undefined ? {} : { GROK_HOME: options.grokHome }),
  };
}

function startGrokTurn(options: GrokBuildAdapterOptions, ctx: AdapterTurnContext): GrokBuildTurn {
  const command = resolveGrokCommand(options.command ?? DEFAULT_GROK_COMMAND);
  const promptFile = promptFilePath(options.promptDir ?? tmpdir());
  const args = buildGrokArgs({
    promptFile,
    cwd: ctx.cwd,
    model: ctx.model,
    resume: ctx.resume,
    permissionMode: options.permissionMode,
    noSubagents: options.noSubagents,
    disableWebSearch: options.disableWebSearch,
    allowRules: options.allowRules,
    denyRules: options.denyRules,
    tools: options.tools,
    disallowedTools: options.disallowedTools,
    maxTurns: options.maxTurns,
    reasoningEffort: options.reasoningEffort,
    extraArgs: options.extraArgs,
  });
  const commandLine = [command, ...args];

  if (ctx.resume !== undefined) {
    const violation = resumeViolationOf(ctx.resume, ctx.cwd);
    if (violation !== undefined) {
      return failFastTurn(commandLine, violation);
    }
  }

  // 提示词必须先落盘再 spawn（grok 启动即读该文件），且 startTurn 是同步接口，
  // 故这里用同步写。文件很小（提示词而已），阻塞可忽略。
  try {
    writeFileSync(promptFile, ctx.prompt, "utf8");
  } catch (error) {
    return failFastTurn(commandLine, `提示词临时文件写入失败（${promptFile}）：${String(error)}`);
  }

  const mapper = createGrokEventMapper({
    cwd: ctx.cwd,
    ...(ctx.model === undefined ? {} : { model: ctx.model }),
  });
  let cancelRequested = false;
  const handle: AgentProcessHandle = (options.spawn ?? spawnAgentProcess)({
    command,
    args,
    cwd: ctx.cwd,
    // headless 不读管道 stdin（官方文档），留着只会让子进程多一个悬空管道。
    stdin: "closed",
    env: grokEnv(options, ctx),
    ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
    ...(options.stripApiKeyEnv === undefined ? {} : { stripApiKeyEnv: options.stripApiKeyEnv }),
  });

  async function* events(): AsyncGenerator<AgentEvent> {
    try {
      // stderr 必须被消费（process/types.ts 的背压约定），同时留尾巴作诊断。
      const stderrTail = readStderrTail(handle.stderr);
      for await (const record of readJsonlStream(handle.stdout)) {
        yield* mapper.map(record);
      }
      const exit = await handle.exitPromise;
      const tail = await stderrTail;
      yield* mapper.finalize({
        cancelled: cancelRequested || exit.kind === "timeout",
        spawnFailed: exit.kind === "spawn-failed",
        exitCode: exit.exitCode,
        error: exit.error ?? (tail === "" ? null : tail),
      });
    } finally {
      // 提示词是任务合同/交接包，不该在临时目录里长期留存；轮次以任何方式
      // 结束（正常收尾、取消、消费方提前 break）都要清掉。
      await unlink(promptFile).catch(() => undefined);
    }
  }

  return {
    events: events(),
    commandLine,
    cancel: async (): Promise<void> => {
      // 无优雅取消协议（§4）：只能整树强杀，事件流由 finalize 收成 cancelled。
      cancelRequested = true;
      await handle.kill();
      // 事件流未被消费时 finally 不会跑，那时这里就是临时文件的唯一清理点。
      await unlink(promptFile).catch(() => undefined);
    },
  };
}

/**
 * ACP 首选轮次：先试 `grok agent stdio`，握手失败按 fallback 语义处置。
 *
 * fallback = true（auto 模式）时降级现行 headless **重跑本轮**——降级安全的前提
 * 是 ACP 尝试在握手失败前**零事件发出、进程已收**（acp-turn 的降级合同）；
 * fallback = false（显式 acp）时如实以 end(failed) 收尾，不静默换路径。
 *
 * 一处如实登记的口径：guard 层以「turn 有无 respondPermission」判定原生审批通道，
 * 而本门面在结果未知时就得交出句柄，故 respondPermission 恒在——**降级发生的那
 * 一轮**，guard 会把动作级 needs_approval 交给收尾审计而不上浮（fail-closed，
 * 不放行任何本该问的操作，只是把「问用户」换成「审计标记」）；同实例的后续轮次
 * 因缓存直接走 headless 纯轮（无 respondPermission），行为与现行完全一致。
 */
function startAcpFirstTurn(
  options: GrokBuildAdapterOptions,
  ctx: AdapterTurnContext,
  fallback: boolean,
  onDetected: (mode: "acp" | "streaming-json") => void,
): GrokBuildTurn {
  const command = resolveGrokCommand(options.command ?? DEFAULT_GROK_COMMAND);
  const args = buildGrokAcpArgs({ model: ctx.model, reasoningEffort: options.reasoningEffort });
  const commandLine = [command, ...args];

  if (ctx.resume !== undefined) {
    const violation = resumeViolationOf(ctx.resume, ctx.cwd);
    if (violation !== undefined) {
      return failFastTurn(commandLine, violation);
    }
  }

  const attempt: GrokAcpAttempt = startGrokAcpAttempt(
    {
      command,
      args,
      spawn: options.spawn ?? spawnAgentProcess,
      env: grokEnv(options, ctx),
      stripApiKeyEnv: options.stripApiKeyEnv,
      handshakeTimeoutMs: options.acpHandshakeTimeoutMs,
      cancelGraceMs: options.acpCancelGraceMs,
    },
    ctx,
  );

  let degradedTurn: GrokBuildTurn | undefined;
  let cancelled = false;

  async function* events(): AsyncGenerator<AgentEvent> {
    const outcome = await attempt.outcome;
    if (outcome.ok) {
      onDetected("acp");
      yield* attempt.events;
      return;
    }
    onDetected("streaming-json");
    if (!fallback) {
      yield {
        kind: "end",
        reason: "failed",
        message: `grok agent stdio（ACP）握手失败且本 Profile 显式要求 ACP 传输：${outcome.reason}`,
      };
      return;
    }
    if (cancelled) {
      // 降级前就被取消：不再起 headless 进程，直接收尾
      yield { kind: "end", reason: "cancelled", message: "轮次在 ACP 降级前已被取消" };
      return;
    }
    // 降级留档（进 Run 原始日志）：为什么这一轮不是 ACP、headless 命令行是什么
    degradedTurn = startGrokTurn(options, ctx);
    yield toRawEvent(
      GROK_BUILD_RUNTIME,
      { reason: outcome.reason, commandLine: degradedTurn.commandLine },
      `grok agent stdio（ACP）握手失败，本轮降级现行 streaming-json 模式：${outcome.reason}`,
    );
    yield* degradedTurn.events;
  }

  return {
    events: events(),
    commandLine,
    respondPermission: (nativeRequestId: string, decision: PermissionDecision): Promise<void> => {
      if (degradedTurn !== undefined) {
        return Promise.reject(
          new GrokAcpProtocolError("本轮已降级 headless 模式，无原生审批通道可回执"),
        );
      }
      return attempt.respondPermission(nativeRequestId, decision);
    },
    cancel: async (): Promise<void> => {
      cancelled = true;
      await attempt.cancel();
      if (degradedTurn !== undefined) {
        await degradedTurn.cancel();
      }
    },
  };
}

/** 构造 Grok Build 适配器。 */
export function createGrokBuildAdapter(options: GrokBuildAdapterOptions = {}): GrokBuildAdapter {
  const transport = options.transport ?? "auto";
  /** auto 模式的探测缓存（实例级，见模块头「检测方式与缓存口径」）。 */
  let detected: "acp" | "streaming-json" | undefined;

  function currentMode(): "acp" | "streaming-json" {
    if (transport === "acp") {
      return "acp";
    }
    if (transport === "streaming-json") {
      return "streaming-json";
    }
    // auto：探测前按 ACP 报（乐观值，论证见模块头能力声明一节）
    return detected ?? "acp";
  }

  return {
    runtime: GROK_BUILD_RUNTIME,
    displayName: "Grok Build",
    capabilities: (): AdapterCapabilities =>
      currentMode() === "acp" ? GROK_BUILD_ACP_CAPABILITIES : GROK_BUILD_CAPABILITIES,
    startTurn: (ctx: AdapterTurnContext): GrokBuildTurn => {
      if (currentMode() === "streaming-json") {
        return startGrokTurn(options, ctx);
      }
      return startAcpFirstTurn(options, ctx, transport === "auto", (mode) => {
        detected = mode;
      });
    },
  };
}
