/**
 * Gemini CLI 适配器（W2.5）。
 *
 * 形态：一轮 = 一次 `gemini -p ... -o stream-json` 进程（turn 模型，adapter.ts 的决策），
 * 多轮靠 `--resume <uuid>` 续接；会话 ID 由 FF-pane 预生成并经 `--session-id` 下发，
 * 省掉"必须解析 init 事件才知道会话 ID"的依赖（调研 §4）。
 *
 * 三条本适配器特有的决策：
 *
 * 1. **Worker 必须 `--approval-mode yolo`**。headless 下 default 会拒掉一切写文件/命令/
 *    网络工具、auto_edit 仍拒 run_shell_command（调研 §3.4 + 内置 write.toml 的 Headless
 *    Denial Rule），Worker 拿不到写权限就等于白跑一轮，且进程仍退 0 —— 是最危险的一类
 *    静默失败。代价是 CLI 侧完全放权：**Gemini CLI 自身不再做任何权限管控，设计文档 §7
 *    的五项权限全部由 FF-pane 外层承担**——每 Run 生成的 `--policy` 策略（本包 policy.ts，
 *    在 CLI 内先拒危险动作）+ W2.7 的运行时裁决与事后校验（越界文件走 git 恢复、任务转
 *    failed）。Planner/Reviewer 传 "plan"（只读研究模式）即可，无需此放权。
 *
 * 2. **权限请求不转发**（capabilities.permissionForwarding = "no"）。非交互模式下
 *    `ask_user` 一律视同 deny，既没有审批事件也没有补批通道（调研 §7 能力 5）。被拒只以
 *    tool_result(status=error) 出现，映射器据此把动作记 denied 并把整轮上浮为 failed。
 *
 * 3. **取消只能杀进程树**（gracefulCancel = "partial"）。非 TTY 下 CLI 不安装任何取消
 *    监听，协议级取消只存在于 ACP 模式（M3 预留）。强杀后会话文件仍在，可 `--resume` 续。
 */

/// <reference types="node" />

import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import type { ModelId, NativeSessionBinding, RuntimeId } from "@ff-pane/shared";
import type { AdapterTurn, AdapterTurnContext, AgentAdapter } from "../adapter.js";
import type { AdapterCapabilities, AgentEvent, StreamChunk } from "../events/index.js";
import { decodeLines, readJsonlStream } from "../events/index.js";
import type { AgentProcessHandle, AgentProcessSpec } from "../process/index.js";
import { spawnAgentProcess } from "../process/index.js";
import type { GeminiApprovalMode } from "./command.js";
import { buildGeminiCommand, GEMINI_DEFAULT_COMMAND } from "./command.js";
import { createGeminiEventMapper, GEMINI_RAW_NOTE_STDERR } from "./events.js";
import { GEMINI_CLI_RUNTIME } from "./native.js";
import type { GeminiPolicyInput } from "./policy.js";
import { buildGeminiPolicyToml } from "./policy.js";
import type { GeminiPolicyFile } from "./policy-file.js";
import { writeGeminiPolicyFile } from "./policy-file.js";

/**
 * 六项能力声明（设计文档 §5.1），逐项对齐调研 §7 的核对表，不美化：
 * - commandEvents 只能是 partial：tool_result **没有结构化退出码字段**，成败只有 status；
 * - gracefulCancel 只能是 partial：无协议级取消，只能杀进程树。
 */
export const GEMINI_CLI_CAPABILITIES: AdapterCapabilities = Object.freeze({
  nativeResume: "yes",
  streaming: "yes",
  fileChangeEvents: "yes",
  commandEvents: "partial",
  permissionForwarding: "no",
  gracefulCancel: "partial",
});

/** 适配器构造选项。 */
export interface GeminiCliAdapterOptions {
  /** 可执行文件名或绝对路径，默认 "gemini"。 */
  readonly command?: string;
  /** 审批模式，默认 "yolo"（Worker 语义，见文件头决策 1）。 */
  readonly approvalMode?: GeminiApprovalMode;
  /**
   * 本 Run 的权限信封：给了就每 Run 生成 `--policy` TOML 下发。
   * 缺席 = 不下发策略文件（CLI 只受 --approval-mode 约束），仅适合联调与只读角色。
   */
  readonly permissionEnvelope?: GeminiPolicyInput["envelope"];
  /** shell = verify_only 时放行的验证命令（任务合同 verify_cmd）。 */
  readonly verifyCommands?: readonly string[];
  /** 策略文件头注释里的 Run/任务标识（排障可溯源）。 */
  readonly policyLabel?: string;
  /** 策略文件所在临时目录的父目录（测试注入）；默认系统临时目录。 */
  readonly policyDir?: string;
  /** 保留策略文件不删（排障用），默认 false = 用完即删。 */
  readonly keepPolicyFile?: boolean;
  /** Profile 默认模型；ctx.model 优先。 */
  readonly defaultModel?: ModelId;
  /** 额外可读目录（`--include-directories`）。 */
  readonly includeDirectories?: readonly string[];
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

interface SessionPlan {
  readonly sessionId?: string;
  readonly resumeSessionId?: string;
}

/**
 * 会话绑定裁决。cwd 不一致的绑定是非法输入（会话按 cwd 隔离，跨目录看不到对方的会话，
 * 调研 §4）——在启动前快速失败，而不是让 CLI 报出难懂的 "no session found"。
 */
function planSession(ctx: AdapterTurnContext, newSessionId: () => string): SessionPlan {
  const resume: NativeSessionBinding | undefined = ctx.resume;
  if (resume === undefined) {
    return { sessionId: newSessionId() };
  }
  if (!isSameCwd(resume.cwd, ctx.cwd)) {
    throw new Error(
      `原生会话恢复失败：会话 ${resume.nativeSessionId} 绑定的工作目录是 ${resume.cwd}，` +
        `与本轮 cwd ${ctx.cwd} 不一致。Gemini CLI 的会话按工作目录隔离，跨目录无法恢复；` +
        "请以原目录重跑，或降级为上下文重建（设计文档 §10.3）。",
    );
  }
  return { resumeSessionId: resume.nativeSessionId };
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
    runtime: GEMINI_CLI_RUNTIME,
    native: line,
    note: GEMINI_RAW_NOTE_STDERR,
  };
}

/**
 * 后台消费 stderr 到缓冲区。
 * 必须消费：W2.1a 的流有背压，两条流都不读会把大输出的进程堵在管道上（types.ts 约定）。
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

function startTurn(options: GeminiCliAdapterOptions, ctx: AdapterTurnContext): AdapterTurn {
  const spawn = options.spawn ?? spawnAgentProcess;
  let cancelRequested = false;
  let handle: AgentProcessHandle | undefined;
  let policyFile: GeminiPolicyFile | undefined;
  let setupError: string | undefined;
  let session: SessionPlan | undefined;

  try {
    session = planSession(ctx, options.newSessionId ?? randomUUID);
    if (options.permissionEnvelope !== undefined) {
      policyFile = writeGeminiPolicyFile(
        buildGeminiPolicyToml({
          envelope: options.permissionEnvelope,
          projectRoot: ctx.cwd,
          ...(options.verifyCommands === undefined
            ? {}
            : { verifyCommands: options.verifyCommands }),
          ...(options.policyLabel === undefined ? {} : { label: options.policyLabel }),
        }),
        {
          ...(options.policyDir === undefined ? {} : { dir: options.policyDir }),
          ...(options.keepPolicyFile === undefined ? {} : { keep: options.keepPolicyFile }),
        },
      );
    }
    const model = ctx.model ?? options.defaultModel;
    const plan = buildGeminiCommand({
      prompt: ctx.prompt,
      approvalMode: options.approvalMode ?? "yolo",
      ...session,
      ...(model === undefined ? {} : { model }),
      ...(policyFile === undefined ? {} : { policyFile: policyFile.path }),
      ...(options.includeDirectories === undefined
        ? {}
        : { includeDirectories: options.includeDirectories }),
      ...(options.extraArgs === undefined ? {} : { extraArgs: options.extraArgs }),
    });

    handle = spawn({
      command: options.command ?? GEMINI_DEFAULT_COMMAND,
      args: plan.args,
      cwd: ctx.cwd,
      stdin: plan.stdin,
      // GEMINI_API_KEY 等密钥只经此表下发（设计文档 §4.3）：buildAgentEnv 的
      // "注入优先于清洗"机制会放行注入表里的名字，故清洗默认保持开启。
      ...(ctx.env === undefined ? {} : { env: ctx.env }),
      ...(options.stripApiKeyEnv === undefined ? {} : { stripApiKeyEnv: options.stripApiKeyEnv }),
      ...(options.baseEnv === undefined ? {} : { baseEnv: options.baseEnv }),
      ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
    });
    if (plan.stdinPayload !== undefined && handle.stdin !== null) {
      handle.stdin.end(plan.stdinPayload, "utf8");
    }
  } catch (error) {
    setupError = error instanceof Error ? error.message : String(error);
  }

  // 预生成/恢复的会话 ID 交给映射器：init 事件即便不报 session_id，
  // session_start 也能给出可登记的原生绑定（调研 §4 的"自行生成 UUID 并登记"）。
  const sessionIdForMapper = session?.sessionId ?? session?.resumeSessionId;

  async function* events(): AsyncGenerator<AgentEvent> {
    if (handle === undefined) {
      // 启动前就失败（会话绑定非法、策略文件写不出、参数装配非法）：不 spawn，
      // 直接以 end(failed) 收尾——事件流仍恰好一条 end（adapter.ts 的流约定）。
      await policyFile?.remove();
      yield {
        kind: "end",
        reason: "failed",
        ...(setupError === undefined ? {} : { message: setupError }),
      };
      return;
    }
    const live = handle;
    const mapper = createGeminiEventMapper({
      cwd: ctx.cwd,
      ...(sessionIdForMapper === undefined ? {} : { sessionId: sessionIdForMapper }),
    });
    const stderrLines: string[] = [];
    const stderrDone = collectStderr(live.stderr, stderrLines);
    try {
      for await (const record of readJsonlStream(live.stdout)) {
        // stderr 与 stdout 交错落档：同一条流即可满足 Run 的 raw_log
        //（events/types.ts 对 RawEvent 的取舍论证）。
        for (const line of stderrLines.splice(0)) {
          yield stderrRawEvent(line);
        }
        for (const event of mapper.map(record)) {
          yield event;
        }
      }
      const exit = await live.exitPromise;
      // 有界等待：W2.1a 的 exitPromise 在 'exit' 后有宽限期即收口，若有孙进程仍占着
      // stderr 管道，无界 await 会让本轮永远等不到 end。宁可少收几行日志。
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
    } finally {
      await policyFile?.remove();
    }
  }

  return {
    events: events(),
    cancel: async (): Promise<void> => {
      cancelRequested = true;
      await handle?.kill();
      await policyFile?.remove();
    },
  };
}

/** 构造 Gemini CLI 适配器。 */
export function createGeminiCliAdapter(options: GeminiCliAdapterOptions = {}): AgentAdapter {
  return {
    runtime: GEMINI_CLI_RUNTIME satisfies RuntimeId,
    displayName: "Gemini CLI",
    capabilities: (): AdapterCapabilities => GEMINI_CLI_CAPABILITIES,
    startTurn: (ctx: AdapterTurnContext): AdapterTurn => startTurn(options, ctx),
  };
}
