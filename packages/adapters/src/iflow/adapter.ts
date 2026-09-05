/**
 * iFlow 适配器（T8.6b）。
 *
 * ## 通道决策：ACP 单通道（两案对比，依据 docs/adapters/iflow.md）
 *
 * - **案 A（选定）ACP 单通道 + 起不来 end(failed) 如实收尾**（opencode 款式：
 *   serve 起不来不静默换 CLI 路径）。一轮恒为 `iflow --experimental-acp` stdio
 *   双工（acp-turn.ts）。理由：headless 的 stdout **没有任何结构化事件**（0.5.19
 *   无 stream-json，纯模型文本混噪音，调研 §3）——六项能力里流式/文件事件/命令
 *   事件/权限转发/优雅取消五项全无，降级轮产不出 Run 要的任何证据；「跑完靠 git
 *   快照补 file_change、--output-file 取会话 ID」能凑出的是一个证据质量断崖的轮
 *   次，且能力声明须按轮切换到「几乎全 no」——这样的降级不是兜底，是把失败伪装
 *   成低质量成功。失败就如实失败，用户看到的是「iflow ACP 起不来」而非一轮不知
 *   道 Agent 干了什么的黑箱。
 * - **案 B（弃）ACP 首选 + headless 降级**（grok T8.5b 款式）。grok 的降级成立
 *   是因为它的 headless streaming-json 与 ACP 是**同一份事件词汇的两个投影**
 *   （六项能力仅权限/取消两项降档）；iFlow 的 headless 是五项全无。另
 *   `--experimental-acp` 的版本漂移风险（experimental 前缀）如实登记 §4.5——
 *   届时的对策是跟版本，不是预建一条产不出证据的假降级链。
 *
 * ## 受管 HOME 隔离（调研 §5.4 待验证项 → 实现单实测通过）
 *
 * iFlow 的 settings 恒在 `os.homedir()/.iflow/`、**不受 IFLOW_HOME 影响**（坑 5）。
 * spawn 时替换 `USERPROFILE`/`HOME` 指向受管目录（command.ts buildIFlowEnv），
 * 实测：settings / projects 会话存储 / cache / log **全部跟走**，用户真实
 * `~/.iflow` 零触碰。受管 settings 是**一行静态常量**（selectedAuthType 钉
 * openai-compatible，IFLOW_MANAGED_SETTINGS_JSON）——三件套（IFLOW_API_KEY /
 * IFLOW_BASE_URL / IFLOW_MODEL_NAME）全走 env（实测最小 settings + 纯 env 双路
 * 全通），密钥不落盘（§4.3）。startTurn 前按需建目录写文件（内容恒同，幂等）。
 * 代价如实登记：受管 HOME 下无用户 OAuth 登录态——但 oauth-iflow 在 0.5.19 已过
 * 日期开关（调研 §5.2），本就近乎不可用，代价为零。
 *
 * ## 反 `.env` 劫持（调研坑 9 → 实现单实测）
 *
 * 用户仓库的 `.env` 会被 CLI 静默加载，`IFLOW_MODEL_NAME=…` 等能改写受管 Run
 * （实测：连 `-m` 命令行参数都被 .env 压过）。防线：三件套经 ctx.env + 模型经
 * buildIFlowEnv **预占**同名变量——CLI 的 dotenv 不覆盖已存在的 env（实测预占
 * 后劫持全部失效）。env 清洗面（IFLOW_* 五形态）见 process/env.ts。
 *
 * ## 六项能力声明（调研 §7 ACP 列 + 实现单实测，不美化）
 * 1. nativeResume **yes**：session/load 真机实测（含加载 headless 建的会话——
 *    两模式共享存储）；限制：绑定 cwd、无法预指定 ID（开轮即得，中断轮凭据在）。
 * 2. streaming **partial**：agent_message_chunk 事件形态真机在，但假模型端下单
 *    chunk 整块到达，**token 级真增量未证实**（真实后端 SSE 片段化待真机，
 *    调研 §10.4）——按 T7.3a 纪律如实报 partial，待真机后翻案。
 * 3. fileChangeEvents **yes**：tool_call_update 的 diff 载荷带 oldText/newText
 *    **和** fileDiff 统一 diff 文本（比 grok 还多一份现成 diff）。
 * 4. commandEvents **partial**：命令原文与输出文本在，**无结构化退出码**
 *    （gemini/qwen 同评级）。
 * 5. permissionForwarding **yes**：session/request_permission 请求/回执闭环真机
 *    实测（allow 落地 / reject 吞工具）；拒绝记账的特有坑防线见 acp-turn 差异 3。
 * 6. gracefulCancel **yes**：session/cancel → stopReason=cancelled 真机实测，
 *    宽限树杀只兜底。
 */

/// <reference types="node" />

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { AdapterTurn, AdapterTurnContext, AgentAdapter } from "../adapter.js";
import type { AdapterCapabilities, AgentEvent } from "../events/index.js";
import type { AgentProcessHandle, AgentProcessSpec } from "../process/index.js";
import { findExecutableOnWindowsPath, spawnAgentProcess } from "../process/index.js";
import type { IFlowAcpTurn } from "./acp-turn.js";
import { startIFlowAcpTurn } from "./acp-turn.js";
import type { IFlowAcpMode } from "./command.js";
import {
  buildIFlowAcpArgs,
  buildIFlowEnv,
  DEFAULT_IFLOW_ACP_MODE,
  DEFAULT_IFLOW_COMMAND,
  IFLOW_DISPLAY_NAME,
  IFLOW_MANAGED_SETTINGS_JSON,
  IFLOW_RUNTIME,
} from "./command.js";

/** 六项能力声明（模块头逐项论证；ACP 单通道，无条件式切换）。 */
export const IFLOW_CAPABILITIES: AdapterCapabilities = Object.freeze({
  nativeResume: "yes",
  streaming: "partial",
  fileChangeEvents: "yes",
  commandEvents: "partial",
  permissionForwarding: "yes",
  gracefulCancel: "yes",
});

/** createIFlowAdapter 的选项。 */
export interface IFlowAdapterOptions {
  /** 可执行文件名或路径，默认 "iflow"。 */
  readonly command?: string | undefined;
  /**
   * 受管 HOME 目录（spawn 时替换 USERPROFILE/HOME，settings/会话存储全部落此，
   * 模块头「受管 HOME 隔离」）。desktop 装配恒注入 `<全局数据根>/iflow-home`；
   * 缺席 = 不替换 HOME、沿用用户真实 `~/.iflow`（仅限用户显式自管 settings 的
   * 场景——届时 FF-pane 不写任何 settings，认证存在性由用户自己负责）。
   */
  readonly managedHome?: string | undefined;
  /** 会话模式，默认 "default"（逐次审批；Planner/Reviewer 传 "plan"）。 */
  readonly mode?: IFlowAcpMode | undefined;
  /** 是否剥离 API key 类环境变量，默认 true（IFLOW_* 清洗面见 process/env.ts）。 */
  readonly stripApiKeyEnv?: boolean | undefined;
  /** 清洗与注入的基底环境（测试注入），默认 process.env。 */
  readonly baseEnv?: NodeJS.ProcessEnv | undefined;
  /** 子进程启动函数（测试接缝），默认 W2.1a 的 spawnAgentProcess。 */
  readonly spawn?: ((spec: AgentProcessSpec) => AgentProcessHandle) | undefined;
  /** ACP 控制面请求超时毫秒（测试注入）。 */
  readonly acpControlTimeoutMs?: number | undefined;
  /** ACP 优雅取消宽限毫秒（测试注入）。 */
  readonly acpCancelGraceMs?: number | undefined;
}

/** iFlow 的一轮：统一 AdapterTurn 之上多一个命令行留档（grok 同款）。 */
export interface IFlowTurn extends AdapterTurn {
  readonly commandLine: readonly string[];
}

/** iFlow 适配器（startTurn 返回收窄到 IFlowTurn）。 */
export interface IFlowAdapter extends AgentAdapter {
  startTurn(ctx: AdapterTurnContext): IFlowTurn;
}

/**
 * Windows 下先把命令名解析成绝对路径（codex/grok 同因：W2.1a 的 PATH 解析读
 * 展开后对象的 `PATH` 键，Windows 实际键名是 `Path`）。iflow 是 npm 垫片
 * （.ps1/.cmd），resolveSpawnTarget 会走 cmd shim 路径。
 */
function resolveIFlowCommand(command: string): string {
  if (process.platform !== "win32") {
    return command;
  }
  return findExecutableOnWindowsPath(command, process.env) ?? command;
}

/** Windows 路径大小写不敏感的目录比较（resume 绑定校验）。 */
function sameDirectory(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** 启动前校验失败：不 spawn，事件流只有一条 end(failed)。 */
function failFastTurn(commandLine: readonly string[], message: string): IFlowTurn {
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

/**
 * 受管 HOME 的静态 settings 落位（幂等：内容恒同的常量，每轮覆写自愈）。
 * 写失败上抛由调用方转 fail-fast——settings 缺席时 env 三件套会被 CLI 推成
 * `iflow` 认证类型撞日期开关（command.ts），必须快速失败而非放进程去撞。
 */
function ensureManagedSettings(managedHome: string): void {
  const dir = path.join(managedHome, ".iflow");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "settings.json"), IFLOW_MANAGED_SETTINGS_JSON, "utf8");
}

function startTurn(options: IFlowAdapterOptions, ctx: AdapterTurnContext): IFlowTurn {
  const command = resolveIFlowCommand(options.command ?? DEFAULT_IFLOW_COMMAND);
  const args = buildIFlowAcpArgs();
  const commandLine = [command, ...args];

  if (ctx.resume !== undefined) {
    if (ctx.resume.nativeSessionId === "") {
      return failFastTurn(commandLine, "resume 绑定缺少 session_id，无法恢复 iFlow 会话");
    }
    if (!sameDirectory(ctx.resume.cwd, ctx.cwd)) {
      return failFastTurn(
        commandLine,
        `iFlow 会话绑定的 cwd（${ctx.resume.cwd}）与本轮 cwd（${ctx.cwd}）不一致：` +
          "iflow 的会话按 cwd 分桶存储，跨目录恢复会找不到会话或在错误目录里施工",
      );
    }
  }

  if (options.managedHome !== undefined) {
    try {
      ensureManagedSettings(options.managedHome);
    } catch (error) {
      return failFastTurn(
        commandLine,
        `受管 iFlow settings 写入失败（${options.managedHome}）：${String(error)}`,
      );
    }
  }

  const turn: IFlowAcpTurn = startIFlowAcpTurn(
    {
      command,
      args,
      spawn: options.spawn ?? spawnAgentProcess,
      env: buildIFlowEnv({
        ctxEnv: ctx.env,
        model: ctx.model,
        managedHome: options.managedHome,
      }),
      mode: options.mode ?? DEFAULT_IFLOW_ACP_MODE,
      baseEnv: options.baseEnv,
      stripApiKeyEnv: options.stripApiKeyEnv,
      controlTimeoutMs: options.acpControlTimeoutMs,
      cancelGraceMs: options.acpCancelGraceMs,
    },
    ctx,
  );

  return {
    events: turn.events,
    commandLine,
    respondPermission: (nativeRequestId, decision) =>
      turn.respondPermission(nativeRequestId, decision),
    cancel: () => turn.cancel(),
  };
}

/** 构造 iFlow 适配器。 */
export function createIFlowAdapter(options: IFlowAdapterOptions = {}): IFlowAdapter {
  return {
    runtime: IFLOW_RUNTIME,
    displayName: IFLOW_DISPLAY_NAME,
    capabilities: (): AdapterCapabilities => IFLOW_CAPABILITIES,
    startTurn: (ctx: AdapterTurnContext): IFlowTurn => startTurn(options, ctx),
  };
}
