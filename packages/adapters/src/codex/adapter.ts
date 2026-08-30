/**
 * Codex CLI 适配器（W2.3）。
 *
 * 进程模型：**一轮 = 一次 spawn**（codex.md §1.1 / §7.2）。首轮
 * `codex exec --json -C <cwd> --skip-git-repo-check ...`，续轮
 * `codex exec resume <thread_id> --json ...`；没有常驻进程，也没有多轮 stdin
 * 协议，故 AdapterTurn 里没有 send()，续轮由调用方再 startTurn(ctx.resume)。
 *
 * 三个必须落实的实测结论：
 * - **stdin 必须关闭**：codex 在 stdin 为管道时会等输入，或把管道内容当
 *   `<stdin>` 块追加进提示词（§1.1）。故 spawn 时 stdin: "closed"。
 * - **沙箱不指望 Codex**：默认 `--dangerously-bypass-approvals-and-sandbox`，
 *   安全由 FF-pane 权限层承担（W2.7）。论证见 command.ts。
 * - **resume 没有 -C**（0.147.0 实测）：工作根只能靠子进程 cwd，所以
 *   ctx.resume.cwd 与 ctx.cwd 不一致时在启动前快速失败——否则 codex 会在错误
 *   的目录里恢复会话，事后无从察觉。
 *
 * diff 自补（file_change 只有路径与 kind，§2.3）：git 快照采集在 git-diff.ts，
 * 本层只做两件事——startTurn 时立刻记基线，file_change 完成时给事件补 diff
 * 字段；补不到就不带该字段，降级原因走 turn.diffDiagnostics()（事件流外）。
 */

/// <reference types="node" />

import path from "node:path";
import process from "node:process";
import type { AdapterTurn, AdapterTurnContext, AgentAdapter } from "../adapter.js";
import type { AdapterCapabilities, AgentEvent } from "../events/index.js";
import { readJsonlStream } from "../events/index.js";
import type { AgentProcessHandle } from "../process/index.js";
import { findExecutableOnWindowsPath, spawnAgentProcess } from "../process/index.js";
import type { CodexSandboxPolicy } from "./command.js";
import { buildCodexArgs, CODEX_RUNTIME, DEFAULT_CODEX_COMMAND } from "./command.js";
import type { CodexDiffCollector, CodexDiffDiagnostics, CodexGitExecutor } from "./git-diff.js";
import { createCodexDiffCollector } from "./git-diff.js";
import { createCodexEventMapper } from "./mapper.js";

/**
 * 六项能力声明，逐项对齐 docs/adapters/codex.md §6 的核对表：
 * 1. 原生会话恢复 yes —— `codex exec resume <thread_id>` 真机验证，同 thread_id、
 *    上下文完整，强杀后仍可恢复；
 * 2. 流式输出 partial —— JSONL 逐行实时（item 粒度），但 agent_message 整条到达，
 *    无 token 级增量，长回答期间无输出；
 * 3. 文件修改事件 partial —— 有路径 + add/update/delete + 状态，**无 diff 正文**，
 *    diff 由本适配器 git 快照自补，补不到就缺席；
 * 4. 命令执行事件 yes —— command_execution 含命令、聚合输出、退出码、状态，
 *    started/completed 双事件；
 * 5. 权限请求转发 no —— `codex exec` 无 `-a` 审批参数、事件流无审批请求类型，
 *    被拒表现为 declined/failed 之后模型自行调整；转发审批需 app-server/MCP
 *    常驻模式，不属 L1 exec 范围。故本适配器不实现 respondPermission；
 * 6. 中途取消 partial —— 无优雅取消协议，只能杀进程树，且无终止事件需自判。
 */
export const CODEX_CAPABILITIES: AdapterCapabilities = {
  nativeResume: "yes",
  streaming: "partial",
  fileChangeEvents: "partial",
  commandEvents: "yes",
  permissionForwarding: "no",
  gracefulCancel: "partial",
};

/** 兜底 end 事件里携带的 stderr 尾巴上限（codex 的日志走 stderr）。 */
const STDERR_TAIL_LIMIT = 2 * 1024;

/** createCodexAdapter 的可选项。 */
export interface CodexAdapterOptions {
  /** codex 可执行文件名或路径，默认 "codex"（npm 全局垫片由 process 层处理）。 */
  readonly command?: string | undefined;
  /** 沙箱策略，默认 bypass（论证见 command.ts）。 */
  readonly sandbox?: CodexSandboxPolicy | undefined;
  /** `-c key=value` 配置覆盖，如 `{ model_reasoning_effort: '"low"' }` 控成本。 */
  readonly configOverrides?: Readonly<Record<string, string>> | undefined;
  /** `--add-dir` 额外可写目录（首轮有效，resume 轮 CLI 不支持该参数）。 */
  readonly addDirs?: readonly string[] | undefined;
  /** 原样追加的 CLI 参数（逃生门）。 */
  readonly extraArgs?: readonly string[] | undefined;
  /** 是否启用 git 快照 diff 自补，默认 true。 */
  readonly collectDiff?: boolean | undefined;
  /** 注入 git 执行器（单测用；默认走 child_process）。 */
  readonly executeGit?: CodexGitExecutor | undefined;
  /** 是否剥离子进程里的 API key 类环境变量，默认 true（见 process/env.ts）。 */
  readonly stripApiKeyEnv?: boolean | undefined;
}

/** Codex 的一轮：在统一 AdapterTurn 之上多两个"事件流外"的返回值。 */
export interface CodexTurn extends AdapterTurn {
  /** 本轮实际执行的命令行（可执行文件 + 参数），供 Run 日志与排障。 */
  readonly commandLine: readonly string[];
  /**
   * diff 自补诊断快照：非 git 目录 / git 不可用等降级原因在此注明
   * （事件流里只会"没有 diff 字段"，说不出为什么）。
   * 事件流收尾（end 到手）后即为完整结论；中途读到的是实时快照。
   */
  diffDiagnostics(): CodexDiffDiagnostics;
}

/** Codex 适配器（startTurn 返回收窄到 CodexTurn）。 */
export interface CodexAdapter extends AgentAdapter {
  startTurn(ctx: AdapterTurnContext): CodexTurn;
}

/**
 * Windows 下先把命令名解析成绝对路径，再交给 spawn 层。
 *
 * 真机冒烟实测的必要性：W2.1a 的 PATH 解析读的是 buildAgentEnv 展开后的普通
 * 对象上的 `PATH` 键，而 Windows 上环境变量的实际键名是 `Path`——process.env
 * 本身是大小写不敏感代理，一旦 `{...process.env}` 展开成普通对象就不是了，
 * 于是 `command: "codex"` 被误判成 ENOENT（本机 codex 确在 PATH 中）。
 * 这里用真 process.env 走 W2.1a 导出的同一个解析器拿绝对路径，绕开该问题；
 * 解析不到就原样返回，仍由 spawn 层归一为 spawn-failed。
 * 问题本体属 W2.1a（已作遗留风险上报），那边修好后本函数可以删。
 */
function resolveCodexCommand(command: string): string {
  if (process.platform !== "win32") {
    return command;
  }
  return findExecutableOnWindowsPath(command, process.env) ?? command;
}

/** Windows 路径大小写不敏感，故按平台规则比较 resume 绑定的 cwd 与本轮 cwd。 */
function sameDirectory(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** 消费 stderr 并留最后一段（codex 日志走 stderr，兜底 end 用得上）。 */
async function readStderrTail(stream: AsyncIterable<Buffer>): Promise<string> {
  let tail = "";
  for await (const chunk of stream) {
    tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL_LIMIT);
  }
  return tail.trim();
}

/** 压根没采集时的诊断（语义是"没采集"，而不是"采集失败"，故写明缘由）。 */
function idleDiagnostics(reason: string): CodexDiffDiagnostics {
  return {
    repoState: "unchecked",
    degradedReason: reason,
    dirtyBeforeTurn: [],
    resolvedPaths: [],
    missingPaths: [],
  };
}

/**
 * 启动前校验失败时的轮次：不 spawn，事件流只有一条 end(failed)。
 * 依据 adapter.ts 的接口约定——startTurn 同步返回句柄，失败经事件流表达。
 */
function failFastTurn(commandLine: readonly string[], message: string): CodexTurn {
  async function* events(): AsyncGenerator<AgentEvent> {
    yield { kind: "end", reason: "failed", message };
  }
  return {
    events: events(),
    commandLine,
    diffDiagnostics: () => idleDiagnostics("本轮启动前即失败，未做 diff 采集"),
    cancel: async (): Promise<void> => {
      // 进程从未启动，取消无事可做（幂等）。
    },
  };
}

/**
 * 给已完成的 file_change 补 diff（Codex 的 file_change 没有 diff 正文，§2.3）。
 *
 * 只补 completed：started 时文件还没落地，failed / denied 时压根没写成，
 * 那时的 diff 不是本次变更。补不到就原样返回，绝不带空 diff 字段。
 * 导出是为了让这条接线可以脱离子进程单测（tests/codex.test.ts）。
 */
export async function attachCodexDiff(
  collector: CodexDiffCollector | undefined,
  event: AgentEvent,
): Promise<AgentEvent> {
  if (collector === undefined || event.kind !== "file_change" || event.status !== "completed") {
    return event;
  }
  const diff = await collector.collect(event.path);
  return diff === undefined ? event : { ...event, diff };
}

function startCodexTurn(options: CodexAdapterOptions, ctx: AdapterTurnContext): CodexTurn {
  const command = resolveCodexCommand(options.command ?? DEFAULT_CODEX_COMMAND);
  // 配置覆盖合并：构造级（options，如成本控制）为底，逐轮级（ctx，如 openai_compatible
  // → model_provider 路由）覆盖同名键。任一为空时不额外分配对象。
  const mergedConfigOverrides =
    options.configOverrides !== undefined || ctx.configOverrides !== undefined
      ? { ...options.configOverrides, ...ctx.configOverrides }
      : undefined;
  const args = buildCodexArgs({
    cwd: ctx.cwd,
    prompt: ctx.prompt,
    model: ctx.model,
    resume: ctx.resume,
    sandbox: options.sandbox,
    ...(mergedConfigOverrides !== undefined ? { configOverrides: mergedConfigOverrides } : {}),
    addDirs: options.addDirs,
    extraArgs: options.extraArgs,
  });
  const commandLine = [command, ...args];

  if (ctx.resume !== undefined) {
    if (ctx.resume.nativeSessionId === "") {
      return failFastTurn(commandLine, "resume 绑定缺少 thread_id，无法恢复 Codex 会话");
    }
    if (!sameDirectory(ctx.resume.cwd, ctx.cwd)) {
      // `codex exec resume` 没有 -C 参数，工作根只能是子进程 cwd；放行就会在
      // 错误目录里恢复会话（文件写到别处），故启动前快速失败。
      return failFastTurn(
        commandLine,
        `Codex 会话绑定的 cwd（${ctx.resume.cwd}）与本轮 cwd（${ctx.cwd}）不一致：` +
          "codex exec resume 无 -C 参数，工作根只能取子进程 cwd，跨目录恢复必然写错位置",
      );
    }
  }

  const collector: CodexDiffCollector | undefined =
    (options.collectDiff ?? true)
      ? createCodexDiffCollector({
          cwd: ctx.cwd,
          ...(options.executeGit === undefined ? {} : { execute: options.executeGit }),
        })
      : undefined;
  // 基线与 codex 启动并发：startTurn 是同步接口（adapter.ts），无处 await。
  // 实际影响可忽略——codex 首次写文件必须先与模型往返若干秒，`git status`
  // 是本地毫秒级操作；且基线只用于"turn 前已脏"标注，不参与 diff 采集本身。
  void collector?.prime();

  const handle: AgentProcessHandle = spawnAgentProcess({
    command,
    args,
    cwd: ctx.cwd,
    stdin: "closed",
    ...(ctx.env === undefined ? {} : { env: ctx.env }),
    ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
    ...(options.stripApiKeyEnv === undefined ? {} : { stripApiKeyEnv: options.stripApiKeyEnv }),
  });

  const mapper = createCodexEventMapper({
    cwd: ctx.cwd,
    ...(ctx.model === undefined ? {} : { model: ctx.model }),
  });
  let cancelRequested = false;

  async function* events(): AsyncGenerator<AgentEvent> {
    // stderr 必须被消费（process/types.ts 的背压约定），同时留尾巴作诊断。
    const stderrTail = readStderrTail(handle.stderr);
    for await (const record of readJsonlStream(handle.stdout)) {
      for (const event of mapper.map(record)) {
        yield await attachCodexDiff(collector, event);
      }
    }
    const exit = await handle.exitPromise;
    const tail = await stderrTail;
    // 等基线落地，保证"流结束后 diffDiagnostics() 是完整结论"——否则轮次很短
    // （如 spawn 失败）时诊断会停在 unchecked，降级原因反而报不出来。
    await collector?.prime();
    // end 恰好一条且在最后：终止事件在 map() 里只登记，这里统一收尾。
    yield* mapper.finalize({
      cancelled: cancelRequested || exit.kind === "timeout",
      spawnFailed: exit.kind === "spawn-failed",
      exitCode: exit.exitCode,
      error: exit.error ?? (tail === "" ? null : tail),
    });
  }

  return {
    events: events(),
    commandLine,
    diffDiagnostics: () =>
      collector?.diagnostics() ?? idleDiagnostics("diff 自补已关闭（collectDiff: false）"),
    cancel: async (): Promise<void> => {
      // 无优雅取消协议（§4）：只能整树强杀，事件流由 finalize 收成 cancelled。
      cancelRequested = true;
      await handle.kill();
    },
  };
}

/** 构造 Codex 适配器。 */
export function createCodexAdapter(options: CodexAdapterOptions = {}): CodexAdapter {
  return {
    runtime: CODEX_RUNTIME,
    displayName: "Codex CLI",
    capabilities: (): AdapterCapabilities => CODEX_CAPABILITIES,
    startTurn: (ctx: AdapterTurnContext): CodexTurn => startCodexTurn(options, ctx),
  };
}
