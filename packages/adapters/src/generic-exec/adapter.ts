/**
 * generic-exec 适配器（W2.2，接入等级 L2）。
 *
 * 契约：任意 CLI 一进一出。事件流形态恒定为
 *   [raw…（仅 jsonl 模式）] → text(final) → end
 * 前置校验失败（如误传 resume、argv 超长）时只发一条 end(failed)，不启动进程。
 * 无论哪条路径，**流都以恰好一条 end 收尾**（adapter.ts 的 AdapterTurn 约定）。
 *
 * 能力声明的逐项论证见 GENERIC_EXEC_CAPABILITIES。
 */

// 本包 tsconfig 未声明 "types"（@types/node 由仓库根 hoist 提供），故沿用
// jsonl.ts / process/types.ts 的做法，以三斜线指令显式纳入 node 类型
// （此处用到全局 TextDecoder 与 NodeJS 命名空间）。
/// <reference types="node" />

import type { RuntimeId } from "@ff-pane/shared";
import type { AdapterTurn, AdapterTurnContext, AgentAdapter } from "../adapter.js";
import { sanitizeOutputExcerpt } from "../auth-probe/index.js";
import type { AdapterCapabilities, AgentEvent, EndEvent } from "../events/index.js";
import { createLineDecoder, parseJsonlLine, toRawEvent } from "../events/index.js";
import type { AgentProcessExit } from "../process/index.js";
import { spawnAgentProcess } from "../process/index.js";
import {
  GenericExecConfigError,
  measureArgvLength,
  renderGenericExecArgs,
  resolveArgvLengthLimit,
  resolveGenericExecCwd,
  resolveStderrCaptureLimit,
  validateGenericExecConfig,
} from "./config.js";
import type { GenericExecConfig } from "./types.js";
import {
  END_MESSAGE_EXCERPT_LENGTH,
  GENERIC_EXEC_RUNTIME,
  TASK_PLACEHOLDER,
  WINDOWS_CMD_SHIM_COMMAND_LINE_LIMIT,
} from "./types.js";

const RUNTIME: RuntimeId = GENERIC_EXEC_RUNTIME;

/**
 * 六项能力（events/types.ts 的三态语义）逐项论证：
 *
 * - nativeResume: "no" —— 一进一出，进程退出即无任何句柄可续。设计文档 §5.2
 *   明说 L2 无会话连续性，故连 partial 都不能给：给了上层就会拿 resume 来调。
 * - streaming: "no" —— **本适配器刻意缓冲全文后一次交付**，理由是通用 CLI 的
 *   stdout 不保证是"给人看的增量文本"：可能是一整块 JSON、表格，或用 \r 刷屏的
 *   进度条。逐块透传会让 UI 渲染出垃圾中间态，而 L2 的价值定位是"拿结果"不是
 *   "看过程"。若把行级到达也算流式而声明 partial，UI 就会给出打字机式的承诺，
 *   那是对消费方说谎——三态的意义正在于此。
 * - fileChangeEvents: "no" —— 没有任何结构化来源。该 CLI 若真的改了文件，
 *   变更由 Run 的 git 快照（core 层）发现，不由本适配器编造事件。
 * - commandEvents: "no" —— 同上，CLI 内部执行了什么外部不可见。
 * - permissionForwarding: "no" —— 无原生审批通道；一切拦截归权限层（W2.7）
 *   在事件流外自产，故本 turn 不实现 respondPermission。
 * - gracefulCancel: "partial" —— 只能树杀（W2.1a killProcessTree），无协议级
 *   优雅取消；能可靠停下，但停下的时刻不受协议保证。
 */
export const GENERIC_EXEC_CAPABILITIES: AdapterCapabilities = {
  nativeResume: "no",
  streaming: "no",
  fileChangeEvents: "no",
  commandEvents: "no",
  permissionForwarding: "no",
  gracefulCancel: "partial",
};

/** 只发一条 end 的事件流（前置校验失败路径）。 */
async function* endOnly(event: EndEvent): AsyncGenerator<AgentEvent> {
  yield event;
}

function failFastTurn(message: string): AdapterTurn {
  return {
    events: endOnly({ kind: "end", reason: "failed", message }),
    cancel: () => Promise.resolve(),
  };
}

/**
 * 消费 stderr 并捕获前 limit 个字符。
 *
 * 必须完整读到流结束：W2.1a 的流有背压，不读的那条流会把子进程堵在写管道上
 * （大量 stderr 输出的 CLI 会因此迟迟不退出）。故超限后只停止累积，不停止读取。
 * 读流异常不上抛——stderr 是诊断通道，不该淹没本轮的主结论。
 */
async function captureStderr(stream: AsyncIterable<Uint8Array>, limit: number): Promise<string> {
  const decoder = new TextDecoder("utf-8");
  let text = "";
  try {
    for await (const chunk of stream) {
      if (text.length < limit) {
        text += decoder.decode(chunk, { stream: true });
      }
    }
    if (text.length < limit) {
      text += decoder.decode();
    }
  } catch {
    // 管道异常：已捕获的部分照旧可用
  }
  return text.length > limit ? text.slice(0, limit) : text;
}

interface EndInputs {
  readonly exit: AgentProcessExit;
  readonly stderrText: string;
  readonly stdoutText: string;
  readonly cancelRequested: boolean;
  readonly timeoutMs: number | undefined;
  readonly streamError: string | undefined;
}

/**
 * 进程终局 → end 事件。
 *
 * 映射规则：
 * - exited + 退出码 0 → completed；非零 → failed（退出码是通用 CLI 唯一的成败信号）；
 * - spawn-failed → failed（L2 最常见的用户错误：命令名拼错 / 未安装，message 必须可行动）；
 * - timeout → cancelled，与 W2.1c 参考范式（fake-adapter）一致：超时是 FF-pane
 *   主动终止，属 EndEvent 注释里的"主动取消"，不是 Runtime 自己崩了。与用户取消的
 *   区别写在 message 里，避免两种 cancelled 混为一谈；
 * - killed 且我们没要求过取消（外部信号）→ crashed；
 * - cancelRequested 优先于退出码：取消后的输出是被截断的，记成 completed 会让
 *   core 层拿一段残缺结果把任务判完成。
 */
function buildEndEvent(inputs: EndInputs): EndEvent {
  const { exit, stderrText, stdoutText, cancelRequested, timeoutMs, streamError } = inputs;
  const notes: string[] = [];
  let reason: EndEvent["reason"];

  if (exit.kind === "spawn-failed") {
    reason = "failed";
    notes.push(exit.error ?? "命令启动失败");
  } else if (exit.kind === "timeout") {
    reason = "cancelled";
    notes.push(
      timeoutMs === undefined ? "超时被终止" : `超时被终止（timeoutMs=${String(timeoutMs)}）`,
    );
  } else if (cancelRequested) {
    reason = "cancelled";
    notes.push("本轮被取消");
  } else if (exit.kind === "killed") {
    reason = "crashed";
    notes.push(exit.error ?? "进程被外部终止（非本适配器发起）");
  } else {
    reason = exit.exitCode === 0 ? "completed" : "failed";
    if (reason === "failed") {
      notes.push(`命令以非零退出码结束：${String(exit.exitCode)}`);
    }
  }

  if (streamError !== undefined) {
    notes.push(`stdout 读取异常：${streamError}`);
  }
  // stderr 摘录只在"有诊断价值"时进 message：失败/取消，或成功但 stdout 为空
  // （"跑通了却什么都没输出"必须给用户线索）。摘录经 W1.5d 的脱敏器处理，
  // 遵设计文档 §4.3——密钥不进日志。
  if (stderrText !== "" && (reason !== "completed" || stdoutText === "")) {
    const excerpt = sanitizeOutputExcerpt(stderrText, END_MESSAGE_EXCERPT_LENGTH);
    if (excerpt !== "") {
      notes.push(`stderr: ${excerpt}`);
    }
  }

  return {
    kind: "end",
    reason,
    ...(exit.exitCode !== null ? { exitCode: exit.exitCode } : {}),
    ...(notes.length > 0 ? { message: notes.join("；") } : {}),
  };
}

/** 前置校验：不合法就不该启动进程。返回拒绝原因，undefined 表示放行。 */
function preflight(
  config: GenericExecConfig,
  ctx: AdapterTurnContext,
  renderedArgs: readonly string[],
): string | undefined {
  if (ctx.resume !== undefined) {
    return (
      "generic-exec 无原生会话（设计文档 §5.2：L2 一进一出、无会话连续性），" +
      "不能恢复会话；请改用 L1 适配器承担需要上下文延续的角色"
    );
  }
  const limit = resolveArgvLengthLimit(config);
  if (config.taskDelivery === "argv" && limit > 0) {
    const length = measureArgvLength(renderedArgs);
    if (length > limit) {
      return (
        `任务文本经 ${TASK_PLACEHOLDER} 渲染后 argv 长约 ${String(length)} 字符，` +
        `超过预算 ${String(limit)}（Windows .cmd 垫片的命令行硬上限为 ` +
        `${String(WINDOWS_CMD_SHIM_COMMAND_LINE_LIMIT)} 字符）；` +
        "请把 taskDelivery 改为 stdin 以传长文本"
      );
    }
  }
  return undefined;
}

function startTurn(config: GenericExecConfig, ctx: AdapterTurnContext): AdapterTurn {
  const viaStdin = config.taskDelivery === "stdin";
  const renderedArgs = viaStdin ? [...config.args] : renderGenericExecArgs(config.args, ctx.prompt);

  const rejection = preflight(config, ctx, renderedArgs);
  if (rejection !== undefined) {
    return failFastTurn(rejection);
  }

  // ctx.model 在 L2 无处安放：模型由该 CLI 自己的配置决定，命令模板里没有替换位。
  // 不报错（否则任何带模型的 Profile 都跑不了本适配器），也不假装生效——
  // 这是 L2 的已知局限，UI 侧提示归 W3.2。
  const timeoutMs = ctx.timeoutMs ?? config.timeoutMs;
  const handle = spawnAgentProcess({
    command: config.command,
    args: renderedArgs,
    cwd: resolveGenericExecCwd(config, ctx.cwd),
    env: { ...(config.env ?? {}), ...(ctx.env ?? {}) },
    stdin: viaStdin ? "pipe" : "closed",
    timeoutMs,
    stripApiKeyEnv: config.stripApiKeyEnv ?? true,
  });

  // 立即投递任务文本并 EOF：CLI 在读到 EOF 前不会开工，不能等到消费事件流时才写。
  // 写失败（进程已死 → EPIPE）由 W2.1a 的 stdin 错误处理吞掉，不升级为未捕获异常。
  if (viaStdin) {
    handle.stdin?.end(ctx.prompt, "utf8");
  }

  let cancelRequested = false;

  async function* events(): AsyncGenerator<AgentEvent> {
    const stderrTask = captureStderr(handle.stderr, resolveStderrCaptureLimit(config));
    const decoder = new TextDecoder("utf-8");
    const lineDecoder = createLineDecoder();
    const jsonl = config.outputFormat === "jsonl";
    let stdoutText = "";
    let lineNumber = 0;
    let streamError: string | undefined;

    /** jsonl 模式：整行 → raw 事件（空行跳过，脏行带原因上交，不中断）。 */
    function toRaw(line: string): AgentEvent | undefined {
      lineNumber += 1;
      const record = parseJsonlLine(line, lineNumber);
      if (record === undefined) {
        return undefined;
      }
      return record.ok
        ? toRawEvent(RUNTIME, record.value)
        : toRawEvent(RUNTIME, record.raw, record.reason);
    }

    try {
      for await (const chunk of handle.stdout) {
        // 自行 decode 而非交给行解码器：既要字节精确的全文，又要（jsonl 模式下）
        // 跨 chunk 的行边界，一次解码同时喂两处。
        const piece = decoder.decode(chunk, { stream: true });
        stdoutText += piece;
        if (jsonl) {
          for (const line of lineDecoder.push(piece)) {
            const event = toRaw(line);
            if (event !== undefined) {
              yield event;
            }
          }
        }
      }
      const tail = decoder.decode();
      stdoutText += tail;
      if (jsonl) {
        for (const line of [...lineDecoder.push(tail), ...lineDecoder.flush()]) {
          const event = toRaw(line);
          if (event !== undefined) {
            yield event;
          }
        }
      }
    } catch (error) {
      // 管道异常不能让流不带 end 就断（AdapterTurn 约定），记下原因继续收尾。
      streamError = error instanceof Error ? error.message : String(error);
    }

    const exit = await handle.exitPromise;
    const stderrText = await stderrTask;

    // 恒定发一条 text：内容可为空。"CLI 跑通了但没输出"是有用的事实，
    // 让消费方靠"有没有 text 事件"去猜远不如给一条空的。
    yield { kind: "text", content: stdoutText, final: true, channel: "answer" };
    yield buildEndEvent({
      exit,
      stderrText,
      stdoutText,
      cancelRequested,
      timeoutMs,
      streamError,
    });
  }

  return {
    events: events(),
    cancel: async (): Promise<void> => {
      cancelRequested = true;
      await handle.kill();
    },
  };
}

/**
 * 构造 generic-exec 适配器。
 *
 * 配置非法即抛 GenericExecConfigError（装配期快速失败）：设置页保存前应先调
 * validateGenericExecConfig 拿到全部违规做行内提示，走到这里还非法就是装配 bug。
 *
 * 注意注册表按 runtime 键唯一（adapter.ts 的 AdapterRegistry）：同一注册表里
 * 只能放一份 "generic-exec"。用户配置多个 L2 工具时，宿主需按 Profile 逐个
 * 实例化，或另行约定注册键——归 W3.2 / 装配工单决策。
 */
export function createGenericExecAdapter(config: GenericExecConfig): AgentAdapter {
  const validation = validateGenericExecConfig(config);
  if (!validation.ok) {
    throw new GenericExecConfigError(validation.violations);
  }
  const displayName = config.displayName ?? `通用命令（${config.command}）`;
  return {
    runtime: RUNTIME,
    displayName,
    capabilities: (): AdapterCapabilities => GENERIC_EXEC_CAPABILITIES,
    startTurn: (ctx: AdapterTurnContext): AdapterTurn => startTurn(config, ctx),
  };
}
