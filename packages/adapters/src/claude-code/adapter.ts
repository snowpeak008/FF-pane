/**
 * Claude Code 适配器（W2.4）。
 *
 * 四家里唯一同时具备**原生权限转发**与**协议级优雅取消**的 Runtime，这两条链路
 * 都建立在 `--input-format stream-json` 的双向管道上（docs/adapters/claude-code.md
 * §5 / §6.3，fixture 04 / 05 是协议样例）：
 *
 * ```text
 * stdout: system/init → assistant/user 事件 → control_request(can_use_tool) → result
 * stdin : user 消息（提示词）→ control_response(allow/deny) → control_request(interrupt)
 * ```
 *
 * 三条设计决策：
 * 1. **取消先 interrupt 再树杀。** Windows 上 Bash 工具经 git-bash 执行，msys 的
 *    孙进程不在可枚举进程树上，硬杀会留孤儿（§5 实测，W2.1a 提醒 7）。故 cancel()
 *    先写 interrupt 控制请求，由 CLI 自己收拾工具进程；只有"CLI 未声明 interrupt
 *    能力 / 写不进 stdin / 超时未收尾"才退回 killProcessTree。
 *    本工单真机冒烟的补充结论：interrupt 换来的是**完整的事件闭环**（工具记
 *    denied、result 给出 aborted_tools、会话已落盘可 resume）与"不必硬杀"，
 *    但 `sleep 60` 的 msys 孙进程实测仍会存活为孤儿——孤儿的根治要靠进程层的
 *    Windows Job Object（W2.1a），适配器层不该假装它已经解决。
 * 2. **result 到达即收束本轮。** 双向管道下 stdin 一直开着，CLI 报出 result 后仍
 *    可能等下一条输入；适配器在 end 事件后关 stdin、等宽限期、必要时树杀，
 *    保证"恰好一条 end 收尾"且不留常驻进程。
 * 3. **stderr 全程收集尾部。** 隐藏参数（--permission-prompt-tool / --max-turns）
 *    若在 CLI 升级后失效，报错只出现在 stderr 且 stdout 一个事件都没有；不收集
 *    就只能看到一个无声的 crashed。收集到的尾部写进 end.message（见 args.ts 文件头）。
 */

/// <reference types="node" />

import { resolve as resolvePath } from "node:path";
import process from "node:process";
import type { RunEndReason } from "@ff-pane/shared";
import type {
  AdapterTurn,
  AdapterTurnContext,
  AgentAdapter,
  PermissionDecision,
} from "../adapter.js";
import type { AdapterCapabilities, AgentEvent, EndEvent, JsonlRecord } from "../events/index.js";
import { readJsonlStream } from "../events/index.js";
import type { AgentProcessExit, AgentProcessHandle, AgentProcessSpec } from "../process/index.js";
import { spawnAgentProcess } from "../process/index.js";
import type { ClaudeCodeCliOptions } from "./args.js";
import { buildClaudeCodeArgs, CLAUDE_CODE_DEFAULT_COMMAND } from "./args.js";
import type { ClaudeStdinMessage } from "./control.js";
import {
  buildInterruptRequest,
  buildPermissionResponse,
  buildUserMessage,
  CLAUDE_UNMAPPED_TOOL_DENY_MESSAGE,
  parseCanUseToolRequest,
  parseControlReceipt,
  serializeStdinLine,
} from "./control.js";
import type { ClaudeCodeMapperState } from "./mapper.js";
import { createClaudeCodeMapperState, mapClaudeCodeRecord, toPermissionPayload } from "./mapper.js";
import type { ClaudeMcpFile } from "./mcp-file.js";
import { claudeMcpToolName, writeClaudeMcpFile } from "./mcp-file.js";
import { CLAUDE_CODE_DISPLAY_NAME, CLAUDE_CODE_RUNTIME } from "./native.js";

/** 等 interrupt 回执 / 取消收尾的时限，超时即树杀兜底（§5 建议 5 秒）。 */
export const CLAUDE_CODE_INTERRUPT_TIMEOUT_MS = 5_000;

/** end 之后等进程自然退出的宽限期，超时即树杀。 */
export const CLAUDE_CODE_EXIT_GRACE_MS = 5_000;

/** stderr 保留的尾部字节上限（诊断够用，不给 OOM 留口子）。 */
export const CLAUDE_CODE_STDERR_TAIL_LIMIT = 8 * 1024;

/** 子进程启动函数（测试注入假 CLI 用）。 */
export type SpawnAgentProcessFn = (spec: AgentProcessSpec) => AgentProcessHandle;

/** 控制协议误用：回执一个不存在/已回执的权限请求、stdin 已不可写等。 */
export class ClaudeCodeProtocolError extends Error {
  override readonly name = "ClaudeCodeProtocolError";
}

/** 适配器构造参数。CLI 参数部分见 ClaudeCodeCliOptions。 */
export interface ClaudeCodeAdapterOptions extends ClaudeCodeCliOptions {
  /** CLI 命令名或路径，默认 "claude"。 */
  readonly command?: string;
  /** 等 interrupt 回执的时限，默认 CLAUDE_CODE_INTERRUPT_TIMEOUT_MS。 */
  readonly interruptTimeoutMs?: number;
  /** end 后等进程退出的宽限期，默认 CLAUDE_CODE_EXIT_GRACE_MS。 */
  readonly exitGraceMs?: number;
  /** 子进程启动函数，默认 W2.1a 的 spawnAgentProcess（测试注入假 CLI）。 */
  readonly spawn?: SpawnAgentProcessFn;
}

interface ResolvedOptions {
  readonly command: string;
  readonly cli: ClaudeCodeCliOptions;
  readonly interruptTimeoutMs: number;
  readonly exitGraceMs: number;
  readonly spawn: SpawnAgentProcessFn;
}

/** interrupt 请求 ID 序号：同一进程内递增，便于在原始日志里对上号。 */
let interruptSeq = 0;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNonEmpty(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

function requirePositiveInteger(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new RangeError(`createClaudeCodeAdapter: ${name} 必须是正整数，收到 ${value}`);
  }
}

function requirePositiveNumber(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new RangeError(`createClaudeCodeAdapter: ${name} 必须是正数，收到 ${value}`);
  }
}

/** Windows 路径大小写不敏感；resume 的 cwd 比对必须按平台规则来。 */
function sameDirectory(left: string, right: string): boolean {
  const a = resolvePath(left);
  const b = resolvePath(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** 竞速一组 promise 与超时；无论谁先到都清掉定时器（不吊住事件循环）。 */
async function raceWithTimeout(
  waits: readonly Promise<unknown>[],
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolveTimeout) => {
    timer = setTimeout(resolveTimeout, timeoutMs);
  });
  try {
    await Promise.race([...waits, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * 六项能力声明（设计文档 §5.1，依据 docs/adapters/claude-code.md §8 逐项实测）。
 *
 * 逐项理由：
 * - nativeResume        `--resume <session_id>` 实测成功（fixture 02）；cwd 成对登记；
 * - streaming           行级流式；`includePartialMessages` 可开 token 级增量（fixture 06）；
 * - fileChangeEvents    `tool_use_result.structuredPatch` 直接给 diff（fixture 02）；
 * - commandEvents       调研记为"是（带保留）"：保留点是**退出码只在成功时可得**
 *   （is_error === false → 0，失败时缺席）。而 CommandEvent 的约定本就是"退出码
 *   取不到就缺席、成败一律由 status 承载"（events/types.ts），claude 有命令原文、
 *   有 stdout/stderr、有成败判据，契约是**满足**的，故如实填 yes，保留点由映射器
 *   注释与本注释留证，不上升为能力缺口（gemini 的 partial 是连成败都要靠文本猜）；
 * - permissionForwarding stdio 控制协议闭环实测通过（fixture 04）；依赖隐藏参数，
 *   故 forwardPermissions=false 时如实降级为 no；
 * - gracefulCancel      interrupt 控制请求实测通过（fixture 05），树杀仅兜底。
 */
function capabilitiesOf(options: ClaudeCodeAdapterOptions): AdapterCapabilities {
  return {
    nativeResume: "yes",
    streaming: "yes",
    fileChangeEvents: "yes",
    commandEvents: "yes",
    permissionForwarding: options.forwardPermissions === false ? "no" : "yes",
    gracefulCancel: "yes",
  };
}

/** 启动前就已判死的一轮：不 spawn，直接以 end(failed) 收尾（快速失败）。 */
function failFastTurn(message: string): AdapterTurn {
  async function* events(): AsyncGenerator<AgentEvent> {
    yield { kind: "end", reason: "failed", message };
  }
  return {
    events: events(),
    respondPermission: (): Promise<void> =>
      Promise.reject(new ClaudeCodeProtocolError("本轮未启动，没有权限请求可回执")),
    cancel: (): Promise<void> => Promise.resolve(),
  };
}

function startClaudeCodeTurn(ctx: AdapterTurnContext, resolved: ResolvedOptions): AdapterTurn {
  // resume 严格绑定 cwd（§4 实测，fixture 09：跨目录 resume 会先吐一行非 JSON
  // 报错再给 error result）。与其让用户读 CLI 的天书报错，不如在这里快速失败。
  if (ctx.resume !== undefined && !sameDirectory(ctx.resume.cwd, ctx.cwd)) {
    return failFastTurn(
      `原生会话「${ctx.resume.nativeSessionId}」绑定的 cwd 是「${ctx.resume.cwd}」，` +
        `与本轮 cwd「${ctx.cwd}」不一致：Claude Code 的 resume 严格绑定 cwd，恢复必然失败`,
    );
  }

  // MCP 注入（T6.6）：逐轮临时配置文件 + 显式放行只读工具。用户的 ~/.claude.json 不动。
  const mcpServers = ctx.mcpServers ?? {};
  const hasMcp = Object.keys(mcpServers).length > 0;
  let mcpFile: ClaudeMcpFile | undefined;
  if (hasMcp) {
    try {
      mcpFile = writeClaudeMcpFile(mcpServers);
    } catch (error) {
      // 装配失败即快速失败：带着"以为挂上了其实没挂"的状态跑完一轮，
      // 表现是模型莫名其妙查不到东西，比直接报错难查得多。
      return failFastTurn(describeError(error));
    }
  }
  const mcpAllowedTools = Object.entries(mcpServers).flatMap(([name, spec]) =>
    (spec.allowedTools ?? []).map((tool) => claudeMcpToolName(name, tool)),
  );

  const args = buildClaudeCodeArgs(resolved.cli, {
    model: ctx.model,
    resumeSessionId: ctx.resume?.nativeSessionId,
    ...(mcpFile !== undefined ? { mcpConfigPath: mcpFile.path } : {}),
    ...(mcpAllowedTools.length > 0 ? { mcpAllowedTools } : {}),
    // 只在本轮确有注入时才谈"忽略用户 MCP 配置"：没注入还传 strict，
    // 等于平白剥夺用户的 MCP 工具而换不来任何东西。
    ...(hasMcp && ctx.inheritUserMcpServers !== true ? { strictMcp: true } : {}),
  });
  const handle = resolved.spawn({
    command: resolved.command,
    args,
    cwd: ctx.cwd,
    env: ctx.env,
    // 不钉基底环境：进程层缺省即 process.env，PATH/PATHEXT 的大小写由
    // windows-command.ts 的 getEnvCaseInsensitive 兜住（根因修复 fcc6ff7）。
    timeoutMs: ctx.timeoutMs,
    // 双向协议的前提：stdin 必须是管道（提示词、审批回执、interrupt 都走它）。
    stdin: "pipe",
  });

  const state: ClaudeCodeMapperState = createClaudeCodeMapperState({
    cwd: ctx.cwd,
    partialMessages: resolved.cli.includePartialMessages === true,
  });
  /** nativeRequestId → 待批工具入参（allow 回执要原样回填 updatedInput）。 */
  const pendingPermissions = new Map<string, Record<string, unknown>>();

  let stderrTail = "";
  let stdinClosed = false;
  let stdinError: string | undefined;
  let writeChain: Promise<void> = Promise.resolve();
  let cancelRequested = false;
  let cancelling: Promise<void> | undefined;
  let interruptRequestId: string | undefined;
  let interruptAccepted = false;
  let watchdog: NodeJS.Timeout | undefined;
  let settling: Promise<AgentProcessExit> | undefined;
  /** 消费方是否正停在"等下一个事件"上——决定 cancel 能否观察到 interrupt 回执。 */
  let consumerPumping = false;
  let finished = false;

  let markReceipt!: () => void;
  const receiptSeen = new Promise<void>((resolveReceipt) => {
    markReceipt = resolveReceipt;
  });

  function writeLine(message: ClaudeStdinMessage): Promise<void> {
    const stdin = handle.stdin;
    if (stdin === null || stdinClosed) {
      return Promise.reject(
        new ClaudeCodeProtocolError("stdin 不可写：进程未启动成功或本轮已收束"),
      );
    }
    const line = serializeStdinLine(message);
    // 串行化写入：控制消息必须整行到达，不能与其他写交错。
    const write = writeChain.then(
      () =>
        new Promise<void>((resolveWrite, rejectWrite) => {
          stdin.write(line, (error) => {
            if (error === null || error === undefined) {
              resolveWrite();
            } else {
              rejectWrite(error);
            }
          });
        }),
    );
    writeChain = write.catch(() => undefined);
    return write;
  }

  function closeStdin(): void {
    if (stdinClosed) {
      return;
    }
    stdinClosed = true;
    handle.stdin?.end();
  }

  function clearWatchdog(): void {
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
  }

  /** interrupt 已发出后的兜底：到期仍未收尾即树杀（不让取消变成永久挂起）。 */
  function armWatchdog(): void {
    if (watchdog !== undefined) {
      return;
    }
    watchdog = setTimeout(() => {
      watchdog = undefined;
      if (!finished) {
        void handle.kill();
      }
    }, resolved.interruptTimeoutMs);
  }

  /** 收束进程：关 stdin → 等宽限期 → 仍在就树杀。幂等。 */
  function settleProcess(): Promise<AgentProcessExit> {
    if (settling === undefined) {
      settling = (async (): Promise<AgentProcessExit> => {
        closeStdin();
        let exited: AgentProcessExit | undefined;
        await raceWithTimeout(
          [
            handle.exitPromise.then((exit) => {
              exited = exit;
            }),
          ],
          resolved.exitGraceMs,
        );
        return exited ?? (await handle.kill());
      })();
    }
    return settling;
  }

  async function collectStderr(): Promise<void> {
    try {
      for await (const chunk of handle.stderr) {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-CLAUDE_CODE_STDERR_TAIL_LIMIT);
      }
    } catch (error) {
      stderrTail = `${stderrTail}\n[stderr 读取失败] ${describeError(error)}`.slice(
        -CLAUDE_CODE_STDERR_TAIL_LIMIT,
      );
    }
  }

  /** 控制协议旁路：回执确认、审批登记、无法表达的工具 fail-closed 自动拒绝。 */
  async function handleControlRecord(value: Record<string, unknown>): Promise<void> {
    const receipt = parseControlReceipt(value);
    if (receipt !== undefined) {
      if (receipt.requestId === interruptRequestId) {
        interruptAccepted = receipt.ok;
        markReceipt();
      }
      return;
    }
    const request = parseCanUseToolRequest(value);
    if (request === undefined) {
      return;
    }
    if (toPermissionPayload(request.toolName, request.input, ctx.cwd) === undefined) {
      // 信封表达不了的工具（Task / Cron* / SendMessage 等逃出工作台执行模型的）：
      // 既不能悬着让 CLI 永远等，也不能编个假类别让用户点同意 → 自动拒绝并留档。
      try {
        await writeLine(
          buildPermissionResponse(
            request.requestId,
            "deny",
            request.input,
            CLAUDE_UNMAPPED_TOOL_DENY_MESSAGE,
          ),
        );
      } catch (error) {
        stdinError = `自动拒绝工具 ${request.toolName} 失败：${describeError(error)}`;
      }
      return;
    }
    // 先登记再让事件出流：消费方拿到 permission_request 时回执凭据必已就位。
    pendingPermissions.set(request.requestId, request.input);
  }

  function enrichEnd(end: EndEvent, extra?: string): EndEvent {
    if (end.reason === "completed") {
      return end;
    }
    const parts = [
      end.message,
      extra,
      stdinError,
      stderrTail === "" ? undefined : `stderr: ${stderrTail.trim()}`,
    ].filter(isNonEmpty);
    return parts.length === 0 ? end : { ...end, message: parts.join(" | ") };
  }

  function synthesizeEnd(exit: AgentProcessExit, streamError: string | undefined): EndEvent {
    // 四家共同兜底（events/types.ts EndEvent）：流断而无终止事件 → 主动取消记
    // cancelled，否则 crashed。claude 硬杀实测无 result 行（fixture 07）。
    const reason: RunEndReason =
      cancelRequested || exit.kind === "timeout" ? "cancelled" : "crashed";
    return enrichEnd(
      {
        kind: "end",
        reason,
        ...(exit.exitCode === null ? {} : { exitCode: exit.exitCode }),
        ...(exit.error === null ? {} : { message: exit.error }),
      },
      streamError,
    );
  }

  async function* events(): AsyncGenerator<AgentEvent> {
    const iterator = readJsonlStream(handle.stdout)[Symbol.asyncIterator]();
    let sawEnd = false;
    let streamError: string | undefined;
    try {
      for (;;) {
        let next: IteratorResult<JsonlRecord>;
        consumerPumping = true;
        try {
          next = await iterator.next();
        } catch (error) {
          streamError = `stdout 读取失败：${describeError(error)}`;
          break;
        } finally {
          consumerPumping = false;
        }
        if (next.done === true) {
          break;
        }
        const record = next.value;
        if (record.ok) {
          await handleControlRecord(record.value);
        }
        for (const event of mapClaudeCodeRecord(state, record)) {
          if (event.kind !== "end") {
            yield event;
            continue;
          }
          sawEnd = true;
          finished = true;
          clearWatchdog();
          yield enrichEnd(event);
        }
        if (sawEnd) {
          // result 已到：收束本轮（双向管道下 CLI 不会自己走，见文件头决策 2）。
          break;
        }
      }
    } finally {
      finished = true;
      clearWatchdog();
      // 消费方提前 break 时这里是唯一的清理点：不 await，避免"流不再前进"把
      // 收束动作也一起吊死；settleProcess 幂等，正常路径下面还会 await 同一个。
      void settleProcess().catch(() => undefined);
      void Promise.resolve(iterator.return?.(undefined)).catch(() => undefined);
      // 临时 MCP 配置用完即删（remove 幂等、失败静默）。与 settleProcess 同理不 await。
      void mcpFile?.remove();
    }
    const exit = await settleProcess();
    if (!sawEnd) {
      yield synthesizeEnd(exit, streamError);
    }
  }

  async function respondPermission(
    nativeRequestId: string,
    decision: PermissionDecision,
  ): Promise<void> {
    const input = pendingPermissions.get(nativeRequestId);
    if (input === undefined) {
      throw new ClaudeCodeProtocolError(
        `权限请求「${nativeRequestId}」不属本轮或已回执过，无法回执`,
      );
    }
    pendingPermissions.delete(nativeRequestId);
    await writeLine(buildPermissionResponse(nativeRequestId, decision, input));
  }

  async function cancel(): Promise<void> {
    if (cancelling !== undefined) {
      await cancelling;
      return;
    }
    cancelRequested = true;
    cancelling = (async (): Promise<void> => {
      if (finished) {
        return;
      }
      // interrupt 协议由 init.capabilities 声明（漂移防御）；未声明 / stdin 不可写
      // 时没有优雅路径，直接树杀。此时 init 尚未到达也意味着还没有工具在跑，
      // 硬杀不会留下 msys 孙进程。
      if (!state.interruptReceiptSupported || handle.stdin === null || stdinClosed) {
        await handle.kill();
        return;
      }
      interruptSeq += 1;
      const requestId = `ffpane-interrupt-${interruptSeq}`;
      interruptRequestId = requestId;
      try {
        await writeLine(buildInterruptRequest(requestId));
      } catch {
        await handle.kill();
        return;
      }
      armWatchdog();
      if (!consumerPumping) {
        // 消费方此刻停在自己的循环体内（典型写法：在 for-await 体里调 cancel），
        // 事件流不前进 → 回执无从观察。立即返回，交给看门狗兜底树杀；
        // 消费方继续消费后 result 会正常到达并以 cancelled 收尾。
        return;
      }
      await raceWithTimeout([receiptSeen, handle.exitPromise], resolved.interruptTimeoutMs);
      if (!interruptAccepted && !finished) {
        await handle.kill();
      }
    })();
    await cancelling;
  }

  void collectStderr();
  // 提示词经 stdin 的 user 消息下发（§3）：双向 stream-json 下没有位置参数这条路。
  void writeLine(buildUserMessage(ctx.prompt)).catch((error: unknown) => {
    stdinError = `提示词写入 stdin 失败：${describeError(error)}`;
  });

  return {
    events: events(),
    ...(resolved.cli.forwardPermissions === false ? {} : { respondPermission }),
    cancel,
  };
}

/**
 * 创建 Claude Code 适配器。
 *
 * 参数非法（maxTurns 非正整数等）在此处抛 RangeError：那是装配错误，
 * 越早失败越好，不该等到 Run 跑起来才在事件流里表达。
 */
export function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions = {}): AgentAdapter {
  requirePositiveInteger("maxTurns", options.maxTurns);
  requirePositiveInteger("interruptTimeoutMs", options.interruptTimeoutMs);
  requirePositiveInteger("exitGraceMs", options.exitGraceMs);
  requirePositiveNumber("maxBudgetUsd", options.maxBudgetUsd);

  const resolved: ResolvedOptions = {
    command: options.command ?? CLAUDE_CODE_DEFAULT_COMMAND,
    cli: options,
    interruptTimeoutMs: options.interruptTimeoutMs ?? CLAUDE_CODE_INTERRUPT_TIMEOUT_MS,
    exitGraceMs: options.exitGraceMs ?? CLAUDE_CODE_EXIT_GRACE_MS,
    spawn: options.spawn ?? spawnAgentProcess,
  };
  const capabilities = capabilitiesOf(options);

  return {
    runtime: CLAUDE_CODE_RUNTIME,
    displayName: CLAUDE_CODE_DISPLAY_NAME,
    capabilities: (): AdapterCapabilities => capabilities,
    startTurn: (ctx: AdapterTurnContext): AdapterTurn => startClaudeCodeTurn(ctx, resolved),
  };
}
