/**
 * Grok Build 适配器（T7.3）。
 *
 * 进程模型：**一轮 = 一次 spawn**（grok-build.md §7.2），与 codex 同构。
 * 首轮 `grok --prompt-file <f> --output-format streaming-json --cwd <dir> --always-approve`，
 * 续轮加 `-r <session_id>`；没有常驻进程也没有多轮 stdin 协议，故 AdapterTurn 里
 * 没有 send()，续轮由调用方再 startTurn(ctx.resume)。
 *
 * 四个必须落实的实测结论：
 * - **提示词写临时文件**：官方明写 headless 不读管道 stdin，而多行长提示词作命令行
 *   参数要顶着 Windows 长度上限与转义风险。文件落在系统临时目录（不是项目里），
 *   轮次结束即删——用户的仓库不该因为跑过一轮而多出任何东西。
 * - **必开 `--always-approve`**：否则每个工具都以「User cancelled」落地而退出码仍是 0
 *   （§7.3 坑 1）。安全由 FF-pane 权限层承担（W2.7），与 codex 的 bypass 同理。
 * - **resume 绑定 cwd**：grok 的会话按 cwd 分桶存储，跨目录恢复会找不到会话或在
 *   错误目录里施工，故 ctx.resume.cwd 与 ctx.cwd 不一致时启动前快速失败。
 * - **不支持 MCP 注入**：grok 只能从用户全局 `~/.grok/config.toml` 或写进用户仓库的
 *   `<cwd>/.grok/config.toml` 读 MCP 配置，没有逐轮注入参数。两条路都与「绝不改写
 *   用户全局配置、不在用户仓库留残留」相抵触，故 ctx.mcpServers 被**忽略**
 *   （T6.6 的知识库工具在本 Runtime 上不可用，如实声明，见 §6）。
 *
 * diff 不需要 git 快照自补：grok 的事件流直接带变更正文（diff.ts）。
 */

/// <reference types="node" />

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import type { AdapterTurn, AdapterTurnContext, AgentAdapter } from "../adapter.js";
import type { AdapterCapabilities, AgentEvent } from "../events/index.js";
import { readJsonlStream } from "../events/index.js";
import type { AgentProcessHandle } from "../process/index.js";
import { findExecutableOnWindowsPath, spawnAgentProcess } from "../process/index.js";
import type { GrokPermissionMode } from "./command.js";
import { buildGrokArgs, DEFAULT_GROK_COMMAND, GROK_BUILD_RUNTIME } from "./command.js";
import { createGrokEventMapper } from "./mapper.js";

/**
 * 六项能力声明，逐项对齐 docs/adapters/grok-build.md §6 的核对表：
 * 1. 原生会话恢复 yes —— `-r <session_id>` 真机验证：sessionId 不变、上下文完整回填；
 * 2. 流式输出 yes —— `text` 事件是真增量（实测一句话被切成两片投递），四家里唯一够格；
 * 3. 文件修改事件 yes —— `content[].type="diff"` 直接给 oldText/newText 全文，
 *    无需 git 快照自补（codex 只给路径）；
 * 4. 命令执行事件 yes —— rawOutput 含退出码、命令、cwd、截断/超时标志与输出，信息最全；
 * 5. 权限请求转发 no —— headless 是单向流，无审批回执通道；待批工具直接以 failed +
 *    「User cancelled」落地。转发审批须走 `grok agent stdio`（ACP 双工，M3 范围）。
 *    故本适配器不实现 respondPermission；
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

/** 兜底 end 事件里携带的 stderr 尾巴上限。 */
const STDERR_TAIL_LIMIT = 2 * 1024;

/** createGrokBuildAdapter 的可选项。 */
export interface GrokBuildAdapterOptions {
  /** grok 可执行文件名或路径，默认 "grok"。 */
  readonly command?: string | undefined;
  /** 权限模式，默认 always-approve（论证见 command.ts）。 */
  readonly permissionMode?: GrokPermissionMode | undefined;
  /** 是否禁止子 Agent，默认 true（论证见 command.ts / §7.3 坑 4）。 */
  readonly noSubagents?: boolean | undefined;
  /** 关闭联网搜索与抓取。 */
  readonly disableWebSearch?: boolean | undefined;
  /** `--allow` 规则。 */
  readonly allowRules?: readonly string[] | undefined;
  /** `--deny` 规则（纵深防御，非唯一防线）。 */
  readonly denyRules?: readonly string[] | undefined;
  /** `--tools` 工具白名单。 */
  readonly tools?: readonly string[] | undefined;
  /** `--disallowed-tools` 工具黑名单。 */
  readonly disallowedTools?: readonly string[] | undefined;
  /** `--max-turns` 成本护栏。 */
  readonly maxTurns?: number | undefined;
  /** `--reasoning-effort` 推理强度。 */
  readonly reasoningEffort?: string | undefined;
  /**
   * 覆盖 `GROK_HOME`（配置 / 认证 / 会话目录）。
   * 缺省沿用用户的 `~/.grok`——那里有他的登录态与会话历史，重定向会让
   * `cli_login` 类 Provider 立刻失效（取舍详见 grok-build.md §7.4）。
   */
  readonly grokHome?: string | undefined;
  /** 提示词临时文件的落点目录，默认系统临时目录（单测注入用）。 */
  readonly promptDir?: string | undefined;
  /** 原样追加的 CLI 参数（逃生门）。 */
  readonly extraArgs?: readonly string[] | undefined;
  /** 是否剥离子进程里的 API key 类环境变量，默认 true（见 process/env.ts）。 */
  readonly stripApiKeyEnv?: boolean | undefined;
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

/**
 * Windows 下先把命令名解析成绝对路径再交给 spawn 层。
 * 与 codex 适配器同因：W2.1a 的 PATH 解析读的是展开后普通对象上的 `PATH` 键，
 * 而 Windows 上实际键名是 `Path`，`grok` 会被误判成 ENOENT。
 */
function resolveGrokCommand(command: string): string {
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

/** 消费 stderr 并留最后一段（grok 的日志与更新提示走 stderr）。 */
async function readStderrTail(stream: AsyncIterable<Buffer>): Promise<string> {
  let tail = "";
  for await (const chunk of stream) {
    tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL_LIMIT);
  }
  return tail.trim();
}

/**
 * 启动前校验失败时的轮次：不 spawn，事件流只有一条 end(failed)。
 * 依据 adapter.ts 的接口约定——startTurn 同步返回句柄，失败经事件流表达。
 */
function failFastTurn(commandLine: readonly string[], message: string): GrokBuildTurn {
  async function* events(): AsyncGenerator<AgentEvent> {
    yield { kind: "end", reason: "failed", message };
  }
  return {
    events: events(),
    commandLine,
    cancel: async (): Promise<void> => {
      // 进程从未启动，取消无事可做（幂等）。
    },
  };
}

/** 提示词临时文件名：随机后缀，避免并发轮次互相覆盖。 */
function promptFilePath(dir: string): string {
  return path.join(dir, `ffpane-grok-prompt-${randomBytes(8).toString("hex")}.txt`);
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
    if (ctx.resume.nativeSessionId === "") {
      return failFastTurn(commandLine, "resume 绑定缺少 session_id，无法恢复 Grok 会话");
    }
    if (!sameDirectory(ctx.resume.cwd, ctx.cwd)) {
      return failFastTurn(
        commandLine,
        `Grok 会话绑定的 cwd（${ctx.resume.cwd}）与本轮 cwd（${ctx.cwd}）不一致：` +
          "grok 的会话按 cwd 分桶存储，跨目录恢复会找不到会话或在错误目录里施工",
      );
    }
  }

  const env: Record<string, string> = {
    ...ctx.env,
    // 更新检查会往 stderr 写东西、拖慢启动；命令行的 --no-auto-update 只管本次，
    // 这条连它自己派生的进程一起管住（grok-build.md §1.2）。
    GROK_DISABLE_AUTOUPDATER: "1",
    ...(options.grokHome === undefined ? {} : { GROK_HOME: options.grokHome }),
  };

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
  const handle: AgentProcessHandle = spawnAgentProcess({
    command,
    args,
    cwd: ctx.cwd,
    // headless 不读管道 stdin（官方文档），留着只会让子进程多一个悬空管道。
    stdin: "closed",
    env,
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

/** 构造 Grok Build 适配器。 */
export function createGrokBuildAdapter(options: GrokBuildAdapterOptions = {}): GrokBuildAdapter {
  return {
    runtime: GROK_BUILD_RUNTIME,
    displayName: "Grok Build",
    capabilities: (): AdapterCapabilities => GROK_BUILD_CAPABILITIES,
    startTurn: (ctx: AdapterTurnContext): GrokBuildTurn => startGrokTurn(options, ctx),
  };
}
