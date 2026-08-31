/**
 * Aider 适配器（T7.3b）。
 *
 * 进程模型：**一轮 = 一次 spawn**（aider.md §7.4），与 codex / grok 同构。
 * 续轮不靠会话 ID（aider 没有），而是让同一个 transcript 文件跨轮存活并加
 * `--restore-chat-history`（§5.1）。故 AdapterTurn 里没有 send()。
 *
 * ## 四件本适配器独有、且必须落实的事
 *
 * 1. **`--model` 与密钥缺一不可，且要在 spawn 前就快速失败。**
 *    两者任一缺席时 aider 会进 onboarding：**唤起默认浏览器**做 OpenRouter OAuth、
 *    起一个 localhost:8484 回调服务端、然后原地等最多 5 分钟。而 `--yes-always`
 *    会把那句「要不要用浏览器连 OpenRouter」自动答成「是」（调研 §7.3 坑 1）。
 *    一个无人值守的 headless 进程因此变成抢用户焦点、挂着不退的僵局。
 *    这是本适配器唯一「宁可不启动」的前置校验：一条说得清原因的 end(failed)
 *    远好过一个会弹窗的进程。
 *
 * 2. **七条红线开关整套显式下发**（command.ts）。aider 默认会往用户仓库写三个
 *    `.aider.*`、改写用户的 `.gitignore`、并且自己 git commit。且默认值可被用户
 *    仓库里的 `.aider.conf.yml` 或用户 shell 里的 `AIDER_*` 变量改掉，
 *    所以只有写进命令行才压得住。
 *
 * 3. **红线跑完还要核查一遍**（verifyNoResidue）。开关生效是"应该"，不是"已经"。
 *    轮次结束后实测仓库里有没有多出 `.aider*`、HEAD 有没有变——多出来就发一条
 *    raw 诊断，让 Run 日志留证。这条核查不能用 `git status`：aider 会把 `.aider*`
 *    写进 `.gitignore`，之后残留文件在 git status 里**就看不见了**（§8.1）。
 *
 * 4. **diff 自己补**。`Applied edit to <path>` 只给路径（§2.4），与 codex 同处境，
 *    故 turn 前记 git 基线、收到标记后按路径取 diff（git-diff.ts，全程只读）。
 */

/// <reference types="node" />

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import type { AdapterTurn, AdapterTurnContext, AgentAdapter } from "../adapter.js";
import type { AdapterCapabilities, AgentEvent } from "../events/index.js";
import { toRawEvent } from "../events/index.js";
import type { AgentProcessHandle } from "../process/index.js";
import { findExecutableOnWindowsPath, spawnAgentProcess } from "../process/index.js";
import {
  AIDER_FIXED_ENV,
  AIDER_RUNTIME,
  buildAiderArgs,
  DEFAULT_AIDER_COMMAND,
} from "./command.js";
import type { AiderDiffCollector, AiderGitExecutor } from "./git-diff.js";
import { createAiderDiffCollector } from "./git-diff.js";
import { createAiderEventMapper } from "./mapper.js";

/**
 * 六项能力声明，逐项对齐 docs/adapters/aider.md §6 的核对表：
 *
 * 1. 原生会话恢复 **partial** —— `--restore-chat-history` 真机验证上下文回填成立
 *    （fixtures 的 real-restore-history 两轮口令逐字符对上）；但 aider 没有会话 ID，
 *    凭据是本适配器自管的 transcript 文件路径，Markdown 往返有损，且只能整份恢复。
 * 2. 流式输出 **yes** —— token 级真增量，实测每个 SSE delta 即时落 stdout。
 * 3. 文件修改事件 **partial** —— `Applied edit to <path>` 给路径与成功事实但**不给 diff**，
 *    diff 由 git 快照自补（与 codex 同档）；失败路径无结构化标记，只有一段人类文本。
 * 4. 命令执行事件 **no** —— headless 下模型请求的命令**结构性地不执行**：
 *    `--yes-always` 对 explicit_yes_required 的询问一律答否（io.py:867），
 *    stdout 上只留一行与正文无从区分的裸命令。aider 自己的 lint/test 钩子虽会起
 *    子进程，但无退出码、test 连标记行都不打印，故不映射为 command 事件。
 * 5. 权限请求转发 **no** —— 无审批回执通道，连拒绝事实都不结构化上报。
 *    故本适配器不实现 respondPermission。
 * 6. 中途取消 **partial** —— 无优雅协议，只能树杀；无终止标记，已落盘的编辑不回滚。
 */
export const AIDER_CAPABILITIES: AdapterCapabilities = {
  nativeResume: "partial",
  streaming: "yes",
  fileChangeEvents: "partial",
  commandEvents: "no",
  permissionForwarding: "no",
  gracefulCancel: "partial",
};

/** 兜底 end 事件里携带的 stderr 尾巴上限。 */
const STDERR_TAIL_LIMIT = 4 * 1024;

/**
 * 密钥变量名：这些里只要有一个非空，aider 就有认证材料、不会进 onboarding。
 *
 * 只列 litellm 最常用的几家。不做穷举也不做「反正有 KEY 字样就算」的模糊判断
 * ——判宽了会放过一个真的会弹浏览器的进程，那是本适配器最不能出的错。
 * 用别家 Provider 时经 requiredKeyEnvNames 显式声明。
 */
export const AIDER_KEY_ENV_NAMES: readonly string[] = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AZURE_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "TOGETHERAI_API_KEY",
  "OLLAMA_API_BASE",
];

/** createAiderAdapter 的可选项。 */
export interface AiderAdapterOptions {
  /** aider 可执行文件名或路径，默认 "aider"。 */
  readonly command?: string | undefined;
  /**
   * 编辑格式（`--edit-format`）。缺省 = 用 aider 对该模型的默认判断
   * （未知模型落 `whole`，已知模型多为 `diff`）。取舍见 aider.md §9 第 2 项。
   */
  readonly editFormat?: string | undefined;
  /** 回答语言（`--chat-language`）；缺省 = aider 按系统区域自行注入一句。 */
  readonly chatLanguage?: string | undefined;
  /** `--reasoning-effort`。 */
  readonly reasoningEffort?: string | undefined;
  /** 是否允许模型建议 shell 命令，默认 false（论证见 command.ts / §4）。 */
  readonly suggestShellCommands?: boolean | undefined;
  /** 是否开启 auto-lint，默认 false（aider 默认是开，会自动多花一轮模型钱）。 */
  readonly autoLint?: boolean | undefined;
  /** 是否开启 auto-test，默认 false。 */
  readonly autoTest?: boolean | undefined;
  /** `--lint-cmd`（可重复）。 */
  readonly lintCommands?: readonly string[] | undefined;
  /** `--test-cmd`。 */
  readonly testCommand?: string | undefined;
  /** 预先纳入会话的可编辑文件（`--file`）。 */
  readonly files?: readonly string[] | undefined;
  /** 预先纳入会话的只读文件（`--read`）。 */
  readonly readOnlyFiles?: readonly string[] | undefined;
  /**
   * 认证所需的环境变量名。缺省用 AIDER_KEY_ENV_NAMES 做「至少有一个」判断。
   * 用自定义 Provider 时显式给出，否则前置校验可能误判为"没有密钥"。
   */
  readonly requiredKeyEnvNames?: readonly string[] | undefined;
  /** 临时文件根目录（提示词 + transcript），默认系统临时目录（单测注入用）。 */
  readonly tempDir?: string | undefined;
  /** git 执行器注入（单测用）。 */
  readonly gitExecutor?: AiderGitExecutor | undefined;
  /** 原样追加的 CLI 参数（逃生门）。 */
  readonly extraArgs?: readonly string[] | undefined;
  /** 是否剥离子进程里的 API key 类环境变量，默认 true（见 process/env.ts）。 */
  readonly stripApiKeyEnv?: boolean | undefined;
}

/** Aider 的一轮：在统一 AdapterTurn 之上多两个"事件流外"的返回值。 */
export interface AiderTurn extends AdapterTurn {
  /** 本轮实际执行的命令行（可执行文件 + 参数），供 Run 日志与排障。 */
  readonly commandLine: readonly string[];
  /**
   * 本轮的会话凭据（transcript 文件路径）= NativeSessionBinding.nativeSessionId。
   * 下一轮把它经 ctx.resume 传回来即可续接。
   */
  readonly sessionFile: string;
}

/** Aider 适配器（startTurn 返回收窄到 AiderTurn）。 */
export interface AiderAdapter extends AgentAdapter {
  startTurn(ctx: AdapterTurnContext): AiderTurn;
}

/**
 * Windows 下先把命令名解析成绝对路径再交给 spawn 层。
 * 与 codex / grok 适配器同因：W2.1a 的 PATH 解析读的是展开后普通对象上的 `PATH` 键，
 * 而 Windows 上实际键名是 `Path`。
 */
function resolveAiderCommand(command: string): string {
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

/** 消费 stderr 并留最后一段（aider 只在 argparse 报错时往 stderr 写东西）。 */
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
function failFastTurn(
  commandLine: readonly string[],
  sessionFile: string,
  message: string,
): AiderTurn {
  async function* events(): AsyncGenerator<AgentEvent> {
    yield { kind: "end", reason: "failed", message };
  }
  return {
    events: events(),
    commandLine,
    sessionFile,
    cancel: async (): Promise<void> => {
      // 进程从未启动，取消无事可做（幂等）。
    },
  };
}

/** 会话目录：transcript 要跨轮存活，故按会话而不是按轮次建目录。 */
function sessionDirFor(root: string, sessionFile: string | undefined): string {
  if (sessionFile !== undefined) {
    return path.dirname(sessionFile);
  }
  return path.join(root, `ffpane-aider-session-${randomBytes(8).toString("hex")}`);
}

/**
 * 红线核查：轮次跑完，用户仓库里不该多出任何 `.aider*`，HEAD 也不该变。
 *
 * 刻意用 readdirSync 列目录而不是 `git status`：aider 默认会把 `.aider*` 写进
 * `.gitignore`，那之后残留文件在 git status 里就看不见了（调研 §8.1 最阴的一条）。
 * 「git status 干净」不等于「仓库没多东西」。
 */
function findAiderResidue(cwd: string): readonly string[] {
  try {
    return readdirSync(cwd).filter((entry) => entry.startsWith(".aider"));
  } catch {
    // 目录读不了（权限/已删）不是本核查该报的错，交给别处的失败路径。
    return [];
  }
}

function startAiderTurn(options: AiderAdapterOptions, ctx: AdapterTurnContext): AiderTurn {
  const command = resolveAiderCommand(options.command ?? DEFAULT_AIDER_COMMAND);
  const tempRoot = options.tempDir ?? tmpdir();
  const sessionDir = sessionDirFor(tempRoot, ctx.resume?.nativeSessionId);
  const chatHistoryFile = path.join(sessionDir, "chat-history.md");
  const inputHistoryFile = path.join(sessionDir, "input-history.txt");
  const promptFile = path.join(
    sessionDir,
    `ffpane-aider-prompt-${randomBytes(8).toString("hex")}.txt`,
  );
  const resuming = ctx.resume !== undefined;

  // --- 启动前快速失败（顺序即优先级：先判会弹浏览器的两项） ---
  //
  // 这些分支刻意不组装完整命令行：参数表要等校验通过才有意义（缺 model 时它压根
  // 组装不出来），而失败原因已经写在 message 里，凑一份半真的命令行只会误导排障。

  if (ctx.model === undefined || ctx.model === "") {
    return failFastTurn(
      [command],
      chatHistoryFile,
      "未指定模型：aider 在没有 --model 时会进入 onboarding 并**唤起浏览器**做 " +
        "OpenRouter OAuth，且 --yes-always 会把那句询问自动答成「是」，" +
        "于是 headless 进程会抢走用户焦点并挂起最多 5 分钟" +
        "（见 docs/adapters/aider.md §7.3 坑 1）。故本轮拒绝启动",
    );
  }

  const keyNames = options.requiredKeyEnvNames ?? AIDER_KEY_ENV_NAMES;
  const env = ctx.env ?? {};
  const hasKey = keyNames.some((name) => {
    const value = env[name];
    return value !== undefined && value !== "";
  });
  if (!hasKey) {
    return failFastTurn(
      [command],
      chatHistoryFile,
      `未经 env 注入任何认证材料（检查的变量：${keyNames.join(" / ")}）：` +
        "aider 在没有密钥时会进入 onboarding 并**唤起浏览器**做 OpenRouter OAuth" +
        "（见 docs/adapters/aider.md §7.3 坑 1）。故本轮拒绝启动。" +
        "密钥只能经 AdapterTurnContext.env 下发（设计文档 §4.3）",
    );
  }

  if (ctx.resume !== undefined) {
    if (ctx.resume.nativeSessionId === "") {
      return failFastTurn(
        [command],
        chatHistoryFile,
        "resume 绑定缺少会话凭据（aider 的会话凭据是 transcript 文件路径），无法恢复对话",
      );
    }
    if (!sameDirectory(ctx.resume.cwd, ctx.cwd)) {
      return failFastTurn(
        [command],
        chatHistoryFile,
        `aider 会话绑定的 cwd（${ctx.resume.cwd}）与本轮 cwd（${ctx.cwd}）不一致：` +
          "transcript 里的文件路径与 repo-map 都是相对当轮 git 根的，" +
          "跨目录恢复会让上下文指向错误的文件",
      );
    }
    if (!existsSync(ctx.resume.nativeSessionId)) {
      return failFastTurn(
        [command],
        chatHistoryFile,
        `会话 transcript 不存在（${ctx.resume.nativeSessionId}）：` +
          "aider 的对话连续性完全依赖这个文件，它没了就只能开新会话",
      );
    }
  }

  let args: readonly string[];
  try {
    args = buildAiderArgs({
      promptFile,
      chatHistoryFile,
      inputHistoryFile,
      model: ctx.model,
      restoreHistory: resuming,
      editFormat: options.editFormat,
      chatLanguage: options.chatLanguage,
      reasoningEffort: options.reasoningEffort,
      suggestShellCommands: options.suggestShellCommands,
      autoLint: options.autoLint,
      autoTest: options.autoTest,
      lintCommands: options.lintCommands,
      testCommand: options.testCommand,
      files: options.files,
      readOnlyFiles: options.readOnlyFiles,
      setEnv: ctx.configOverrides,
      extraArgs: options.extraArgs,
    });
  } catch (error) {
    // assertNoSecretInSetEnv 的快速失败走这里（密钥不得进 argv）。
    return failFastTurn([command], chatHistoryFile, String(error));
  }
  const commandLine = [command, ...args];

  // 提示词与 transcript 都落在会话目录里（**不在用户仓库**，§8.2）。
  try {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(promptFile, ctx.prompt, "utf8");
  } catch (error) {
    return failFastTurn(
      commandLine,
      chatHistoryFile,
      `提示词临时文件写入失败（${promptFile}）：${String(error)}`,
    );
  }

  const collector: AiderDiffCollector = createAiderDiffCollector({
    cwd: ctx.cwd,
    ...(options.gitExecutor === undefined ? {} : { execute: options.gitExecutor }),
  });
  const mapper = createAiderEventMapper({
    cwd: ctx.cwd,
    sessionId: chatHistoryFile,
    ...(ctx.model === undefined ? {} : { model: ctx.model }),
    wasTracked: (filePath: string) => collector.wasTrackedBeforeTurn(filePath),
  });

  const childEnv: Record<string, string> = {
    ...ctx.env,
    ...AIDER_FIXED_ENV,
  };

  let cancelRequested = false;
  let handle: AgentProcessHandle | null = null;

  async function* events(): AsyncGenerator<AgentEvent> {
    // git 基线必须在 spawn 前记：aider 一启动就可能改文件，事后记基线会把
    // 本轮自己的改动当成"turn 前就脏"。同一个 await 也让 wasTrackedBeforeTurn
    // 在流开始前就可用（mapper 判 add/update 是同步的）。
    await collector.prime();

    handle = spawnAgentProcess({
      command,
      args,
      cwd: ctx.cwd,
      // aider 全程不读 stdin（实测），留着只会让子进程多一个悬空管道。
      stdin: "closed",
      env: childEnv,
      ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
      ...(options.stripApiKeyEnv === undefined ? {} : { stripApiKeyEnv: options.stripApiKeyEnv }),
    });
    const activeHandle = handle;

    try {
      // stderr 必须被消费（process/types.ts 的背压约定），同时留尾巴作诊断。
      const stderrTail = readStderrTail(activeHandle.stderr);

      // 仓库 .env 会覆盖注入的 env（§7.3 坑 4）：不静默、不代替用户决定，只留证。
      for (const candidate of [".env"]) {
        if (existsSync(path.join(ctx.cwd, candidate))) {
          yield toRawEvent(
            AIDER_RUNTIME,
            { dotenv: candidate, cwd: ctx.cwd },
            `用户仓库里存在 ${candidate}：aider 会以 override=True 加载它，` +
              "其中的 OPENAI_API_KEY / OPENAI_BASE_URL 等会**覆盖** FF-pane 注入的同名变量" +
              "（见 docs/adapters/aider.md §7.3 坑 4）。本轮实际使用的 Provider 可能与 Profile 配置不一致",
          );
        }
      }

      for await (const chunk of activeHandle.stdout) {
        for (const event of mapper.push(chunk.toString("utf8"))) {
          if (event.kind === "file_change" && event.status === "completed") {
            // diff 自补：aider 只给路径（§2.4）。补不到就让字段缺席，不造假空 diff。
            const diff = await collector.collect(event.path);
            yield diff === undefined ? event : { ...event, diff };
            continue;
          }
          yield event;
        }
      }

      const exit = await activeHandle.exitPromise;
      const tail = await stderrTail;

      // 红线核查（论证见模块头第 3 点）。核查失败不改变 end.reason——
      // 残留是本产品的实现问题，不是这一轮任务的成败，故报诊断而不篡改结论。
      const residue = findAiderResidue(ctx.cwd);
      if (residue.length > 0) {
        yield toRawEvent(
          AIDER_RUNTIME,
          { residue, cwd: ctx.cwd },
          `红线告警：轮次结束后用户仓库里出现 aider 残留文件（${residue.join("、")}）——` +
            "残留控制开关未生效，请检查用户仓库的 .aider.conf.yml 与环境里的 AIDER_* 变量",
        );
      }
      const headBefore = collector.diagnostics().headBeforeTurn;
      const headAfter = await collector.headAfterTurn();
      if (headBefore !== undefined && headAfter !== undefined && headBefore !== headAfter) {
        yield toRawEvent(
          AIDER_RUNTIME,
          { headBefore, headAfter },
          "红线告警：轮次结束后 git HEAD 发生了变化——本轮有人造了提交，" +
            "--no-auto-commits / --no-dirty-commits 未生效",
        );
      }

      yield* mapper.finalize({
        cancelled: cancelRequested || exit.kind === "timeout",
        spawnFailed: exit.kind === "spawn-failed",
        exitCode: exit.exitCode,
        error: exit.error ?? (tail === "" ? null : tail),
      });
    } finally {
      // 提示词是任务合同/交接包，不该在临时目录里长期留存；轮次以任何方式结束
      // （正常收尾、取消、消费方提前 break）都要清掉。
      // **transcript 刻意不删**：它是会话凭据，要跨轮存活（§8.2）。
      await unlink(promptFile).catch(() => undefined);
    }
  }

  return {
    events: events(),
    commandLine,
    sessionFile: chatHistoryFile,
    cancel: async (): Promise<void> => {
      // 无优雅取消协议（§7.5）：只能整树强杀，事件流由 finalize 收成 cancelled。
      cancelRequested = true;
      await handle?.kill();
      // 事件流未被消费时 finally 不会跑，那时这里就是提示词文件的唯一清理点。
      await unlink(promptFile).catch(() => undefined);
    },
  };
}

/** 构造 Aider 适配器。 */
export function createAiderAdapter(options: AiderAdapterOptions = {}): AiderAdapter {
  return {
    runtime: AIDER_RUNTIME,
    displayName: "Aider",
    capabilities: (): AdapterCapabilities => AIDER_CAPABILITIES,
    startTurn: (ctx: AdapterTurnContext): AiderTurn => startAiderTurn(options, ctx),
  };
}
