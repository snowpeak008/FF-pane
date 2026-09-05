/**
 * Qwen Code 适配器（T8.6a）。
 *
 * 形态：一轮 = 一次 `qwen -o stream-json --include-partial-messages …` 进程
 * （turn 模型），提示词经 stdin 管道写入（npm .cmd 垫片会截断多行 positional，
 * 调研 §8 坑 5；`-p` 已弃用），多轮靠 `--resume <uuid>` 续接；会话 ID 由 FF-pane
 * 预生成并经 `--session-id` 下发（与 `--resume` 互斥，CLI 强制）。
 *
 * 三条本适配器特有的决策（docs/adapters/qwen-code.md）：
 *
 * 1. **Worker 必须 `--approval-mode yolo`**。headless 下 default 把写文件/命令工具
 *    直接摘出注册表、模型硬发调用则结构化拒绝，而进程仍退 0、result 仍 success
 *    （§8 坑 4）——CLI 侧完全放权，五项权限全部由 FF-pane 外层承担（qwen 无 gemini
 *    的 --policy 策略引擎，纵深防御少一层，如实登记）。Planner/Reviewer 传 "plan"。
 * 2. **三坑防线全在映射器 finish()**：permission_denials 非空 → failed；
 *    `[API Error:` 文本标记 → failed；result 已到达时退出码不参与成败判定
 *    （Windows 退出期 libuv 崩溃 0xC0000409 在 result 落出之后，§8 坑 3）。
 * 3. **取消只能杀进程树**（gracefulCancel = "partial"）。headless 下 CLI 不装取消
 *    监听；interrupt 控制请求归 `--input-format stream-json` 双向 SDK 模式（官方
 *    标注 under construction，§3.4/§5）——稳定后是把能力 5/6 翻案的路径，届时照
 *    claude 双向款式接。强杀后会话文件已落可 `--resume` 续（真机实测）。
 */

/// <reference types="node" />

import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import type { RuntimeId } from "@ff-pane/shared";
import type { AdapterTurn, AdapterTurnContext, AgentAdapter } from "../adapter.js";
import type { AdapterCapabilities, AgentEvent, StreamChunk } from "../events/index.js";
import { decodeLines, readJsonlStream } from "../events/index.js";
import type { AgentProcessHandle, AgentProcessSpec } from "../process/index.js";
import { spawnAgentProcess } from "../process/index.js";
import type { QwenApprovalMode, QwenAuthType } from "./command.js";
import { buildQwenCommand, DEFAULT_QWEN_COMMAND, planQwenSession } from "./command.js";
import { createQwenEventMapper, QWEN_RAW_NOTE_STDERR } from "./mapper.js";
import { QWEN_CODE_DISPLAY_NAME, QWEN_CODE_RUNTIME } from "./native.js";

/**
 * 六项能力声明（设计文档 §5.1），逐项对齐调研 §9 的核对表，不美化：
 * - nativeResume 是：--resume 真机实测（session_id 复用；强杀后仍可恢复——
 *   init 首行就有 session_id，中断轮凭据可用）；
 * - streaming 是：--include-partial-messages 下 content_block_delta 是 token 级真增量；
 * - fileChangeEvents 只能是 partial：tool_result 无 diff 正文（gemini 有统一 diff
 *   文本，qwen 的投影丢掉了）——仅 edit 类可从 old/new 参数渲染，write_file 覆盖
 *   场景旧内容不可得，不自造；
 * - commandEvents 只能是 partial：tool_result 无结构化退出码（gemini 同款评级）；
 * - permissionForwarding 否：单发 headless 下源码明确按本地审批模式立即裁决、
 *   不发 can_use_tool（调研 §3.4）；
 * - gracefulCancel 只能是 partial：无协议级取消，只能杀进程树。
 */
export const QWEN_CODE_CAPABILITIES: AdapterCapabilities = Object.freeze({
  nativeResume: "yes",
  streaming: "yes",
  fileChangeEvents: "partial",
  commandEvents: "partial",
  permissionForwarding: "no",
  gracefulCancel: "partial",
});

/** 适配器构造选项。 */
export interface QwenCodeAdapterOptions {
  /** 可执行文件名或绝对路径，默认 "qwen"。 */
  readonly command?: string;
  /** 审批模式，默认 "yolo"（Worker 语义，见文件头决策 1）。 */
  readonly approvalMode?: QwenApprovalMode;
  /** 认证协议，默认 "openai"（调研 §6 主路径；凭据经 ctx.env 注入）。 */
  readonly authType?: QwenAuthType;
  /** Profile 默认模型；ctx.model 优先。 */
  readonly defaultModel?: string;
  /** 额外可读目录（`--include-directories`）。 */
  readonly includeDirectories?: readonly string[];
  /** 轮数上限（`--max-session-turns`）。 */
  readonly maxSessionTurns?: number;
  /** 关闭 --safe-mode（默认开启）。 */
  readonly safeMode?: boolean;
  /** 逃生舱：追加的原始 CLI 参数。 */
  readonly extraArgs?: readonly string[];
  /** 是否剥离环境里的 API key 类变量，默认 true（密钥只走 ctx.env 注入）。 */
  readonly stripApiKeyEnv?: boolean;
  /** 清洗与注入的基底环境（测试注入），默认 process.env。 */
  readonly baseEnv?: NodeJS.ProcessEnv;
  /** 新会话 UUID 生成器（测试注入），默认 crypto.randomUUID。 */
  readonly newSessionId?: () => string;
  /** 子进程启动函数（测试接缝），默认 W2.1a 的 spawnAgentProcess。 */
  readonly spawn?: (spec: AgentProcessSpec) => AgentProcessHandle;
}

/** cwd 归一化比较：Windows 下大小写不敏感，其余平台敏感。 */
function isSameCwd(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** 进程退出后等 stderr 收尾的宽限期。 */
const STDERR_DRAIN_GRACE_MS = 2_000;

/** 有界等待：到期就放手，不让日志收尾拖住 end 事件。 */
async function waitBounded(task: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([task, deadline]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
}

/** stderr 行 → raw 事件（调研 §3.3：只留档不解析）。 */
function stderrRawEvent(line: string): AgentEvent {
  return {
    kind: "raw",
    runtime: QWEN_CODE_RUNTIME,
    native: line,
    note: QWEN_RAW_NOTE_STDERR,
  };
}

/**
 * 后台消费 stderr 到缓冲区。
 * 必须消费：W2.1a 的流有背压，两条流都不读会把大输出的进程堵在管道上。
 */
async function collectStderr(stream: AsyncIterable<StreamChunk>, sink: string[]): Promise<void> {
  try {
    for await (const line of decodeLines(stream)) {
      sink.push(line);
    }
  } catch (error) {
    sink.push(
      `[ff-pane] 读取 stderr 失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function startTurn(options: QwenCodeAdapterOptions, ctx: AdapterTurnContext): AdapterTurn {
  const spawn = options.spawn ?? spawnAgentProcess;
  let cancelRequested = false;
  let handle: AgentProcessHandle | undefined;
  let setupError: string | undefined;
  let session: { sessionId?: string; resumeSessionId?: string } | undefined;

  try {
    session = planQwenSession({
      cwd: ctx.cwd,
      resume: ctx.resume,
      newSessionId: options.newSessionId ?? randomUUID,
      isSameCwd,
    });
    const model = ctx.model ?? options.defaultModel;
    const args = buildQwenCommand({
      approvalMode: options.approvalMode ?? "yolo",
      ...(options.authType === undefined ? {} : { authType: options.authType }),
      ...session,
      ...(model === undefined ? {} : { model: model as never }),
      ...(options.includeDirectories === undefined
        ? {}
        : { includeDirectories: options.includeDirectories }),
      ...(options.maxSessionTurns === undefined
        ? {}
        : { maxSessionTurns: options.maxSessionTurns }),
      ...(options.safeMode === undefined ? {} : { safeMode: options.safeMode }),
      ...(options.extraArgs === undefined ? {} : { extraArgs: options.extraArgs }),
    });

    handle = spawn({
      command: options.command ?? DEFAULT_QWEN_COMMAND,
      args,
      cwd: ctx.cwd,
      // 提示词恒走 stdin（文件头）：stdin 非 TTY 管道即触发 headless（真机实测）。
      stdin: "pipe",
      // OPENAI_API_KEY / OPENAI_BASE_URL 等密钥只经此表下发（设计文档 §4.3）：
      // buildAgentEnv 的"注入优先于清洗"机制会放行注入表里的名字。
      ...(ctx.env === undefined ? {} : { env: ctx.env }),
      ...(options.stripApiKeyEnv === undefined ? {} : { stripApiKeyEnv: options.stripApiKeyEnv }),
      ...(options.baseEnv === undefined ? {} : { baseEnv: options.baseEnv }),
      ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
    });
    if (handle.stdin !== null) {
      handle.stdin.end(ctx.prompt, "utf8");
    }
  } catch (error) {
    setupError = error instanceof Error ? error.message : String(error);
  }

  // 预生成/恢复的会话 ID 交给映射器：init 行即便不报 session_id，
  // session_start 也能给出可登记的原生绑定（调研 §4）。
  const sessionIdForMapper = session?.sessionId ?? session?.resumeSessionId;

  async function* events(): AsyncGenerator<AgentEvent> {
    if (handle === undefined) {
      // 启动前就失败（会话绑定非法、参数装配非法）：不 spawn，直接以 end(failed)
      // 收尾——事件流仍恰好一条 end（adapter.ts 的流约定）。
      yield {
        kind: "end",
        reason: "failed",
        ...(setupError === undefined ? {} : { message: setupError }),
      };
      return;
    }
    const live = handle;
    const mapper = createQwenEventMapper({
      cwd: ctx.cwd,
      ...(sessionIdForMapper === undefined ? {} : { sessionId: sessionIdForMapper }),
    });
    const stderrLines: string[] = [];
    const stderrDone = collectStderr(live.stderr, stderrLines);
    for await (const record of readJsonlStream(live.stdout)) {
      // stderr 与 stdout 交错落档：同一条流即可满足 Run 的 raw_log。
      for (const line of stderrLines.splice(0)) {
        yield stderrRawEvent(line);
      }
      for (const event of mapper.map(record)) {
        yield event;
      }
    }
    const exit = await live.exitPromise;
    // 有界等待：孙进程占着 stderr 管道时，无界 await 会让本轮永远等不到 end。
    await waitBounded(stderrDone, STDERR_DRAIN_GRACE_MS);
    for (const line of stderrLines.splice(0)) {
      yield stderrRawEvent(line);
    }
    yield* mapper.finish({
      endKind: exit.kind,
      exitCode: exit.exitCode,
      cancelRequested,
      processError: exit.error,
    });
  }

  return {
    events: events(),
    cancel: async (): Promise<void> => {
      cancelRequested = true;
      await handle?.kill();
    },
  };
}

/** 构造 Qwen Code 适配器。 */
export function createQwenCodeAdapter(options: QwenCodeAdapterOptions = {}): AgentAdapter {
  return {
    runtime: QWEN_CODE_RUNTIME satisfies RuntimeId,
    displayName: QWEN_CODE_DISPLAY_NAME,
    capabilities: (): AdapterCapabilities => QWEN_CODE_CAPABILITIES,
    startTurn: (ctx: AdapterTurnContext): AdapterTurn => startTurn(options, ctx),
  };
}
