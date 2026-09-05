/**
 * iFlow CLI 命令行与环境组装（T8.6b）。
 *
 * 参数面出奇地小，这是**ACP 单通道**决策的直接结果（两案对比见 adapter.ts 头注）：
 * 一轮恒为 `iflow --experimental-acp`（stdio JSON-RPC），模型 / 会话 / 审批模式全部
 * 走协议面（session/new、session/load、session/set_mode），不走命令行参数。
 *
 * 两个刻意不用的参数（0.5.19 真机实测，docs/adapters/iflow.md）：
 * - **不用 `-m <model>`**：实现单实测（受管 HOME + 项目 `.env` 写 `IFLOW_MODEL_NAME`）
 *   `-m` 会被项目 `.env` 的值**压过**（session/new 回显 currentModelId = .env 值，
 *   模型端收到的也是 .env 值）——命令行参数在 iFlow 的配置解析里优先级低于 dotenv。
 *   可靠通道是**预占环境变量 `IFLOW_MODEL_NAME`**：CLI 的 dotenv 加载不覆盖已存在的
 *   env（实测：预占后 .env 的劫持值全部失效），故模型经 buildIFlowEnv 注入。
 * - **不用 `--port`**：网络模式形态未实测（调研 §10.4），stdio 是唯一验证过的通道。
 */

import type { ModelId, RuntimeId } from "@ff-pane/shared";

/** Runtime 注册键（src/adapter.ts KNOWN_RUNTIMES 之一）。 */
export const IFLOW_RUNTIME: RuntimeId = "iflow";

/** 界面显示名。 */
export const IFLOW_DISPLAY_NAME = "iFlow CLI";

/** 默认可执行文件名（npm 全局安装，Windows 下是 %APPDATA%\npm 的 .ps1/.cmd 垫片）。 */
export const DEFAULT_IFLOW_COMMAND = "iflow";

/**
 * ACP 会话模式（session/new 响应 availableModes 的消费子集）。
 * - `default`：逐工具审批 → session/request_permission 真转发（本适配器默认，
 *   权限裁决归 FF-pane 权限层——与 grok ACP 不带 --always-approve 同精神）；
 * - `plan`：只读模式（Planner / Reviewer 语义，写侧工具从注册表摘除）。
 * **刻意不提供 `yolo` / `smart`**：yolo 全放行会绕开权限层（session/new 的默认
 * currentModeId 恰是 yolo，见 buildIFlowAcpArgs 注释与 acp-turn 的 set_mode 纪律）；
 * smart 是 CLI 侧的"AI 风险评估"，裁决权外包给模型与权限层语义冲突。
 */
export const IFLOW_ACP_MODES = ["default", "plan"] as const;

/** ACP 会话模式。 */
export type IFlowAcpMode = (typeof IFLOW_ACP_MODES)[number];

/** 默认会话模式（论证见 IFLOW_ACP_MODES）。 */
export const DEFAULT_IFLOW_ACP_MODE: IFlowAcpMode = "default";

/**
 * 组装 ACP 模式参数表。恒为 `--experimental-acp`（stdio）——参数面刻意最小化，
 * 一切轮次语义走协议（模块头）。
 */
export function buildIFlowAcpArgs(): string[] {
  return ["--experimental-acp"];
}

/** buildIFlowEnv 的输入。 */
export interface IFlowEnvInput {
  /** Run 级注入表（IFLOW_API_KEY / IFLOW_BASE_URL 由 desktop env 装配下发）。 */
  readonly ctxEnv?: Readonly<Record<string, string>> | undefined;
  /** 本轮模型（→ IFLOW_MODEL_NAME 预占，见模块头「不用 -m」）。 */
  readonly model?: ModelId | undefined;
  /** 受管 HOME 目录；缺席 = 沿用用户真实 HOME（不推荐，见 adapter.ts）。 */
  readonly managedHome?: string | undefined;
}

/**
 * 组装 iFlow 子进程环境。三层语义：
 * 1. ctx.env 打底（密钥三件套经此下发，设计文档 §4.3：env 是唯一密钥通道）；
 * 2. `IFLOW_MODEL_NAME` 预占——既是模型下发通道，也是**反 `.env` 劫持**：iFlow 会
 *    静默加载 cwd 向上与 `~/.iflow/` 的 `.env`（调研 §5.4），用户仓库里的
 *    `IFLOW_MODEL_NAME=…` 会改写受管 Run 的模型；dotenv 不覆盖已存在的 env
 *    （实测），预占即免疫。API_KEY / BASE_URL 的同款预占由 ctx.env 注入天然完成；
 * 3. `USERPROFILE` + `HOME` 双替换指向受管 HOME——iFlow 的 settings 恒在
 *    `os.homedir()/.iflow/`、不受 IFLOW_HOME 影响（调研 §5.4 坑 5），Node 的
 *    os.homedir() 在 Windows 读 USERPROFILE、POSIX 读 HOME，双设跨平台稳。
 *    实测：替换后 settings / projects 会话存储 / cache / log 全部落受管目录，
 *    用户真实 `~/.iflow` 零触碰。
 */
export function buildIFlowEnv(input: IFlowEnvInput): Record<string, string> {
  return {
    ...input.ctxEnv,
    ...(input.model === undefined || input.model === "" ? {} : { IFLOW_MODEL_NAME: input.model }),
    ...(input.managedHome === undefined
      ? {}
      : { USERPROFILE: input.managedHome, HOME: input.managedHome }),
  };
}

/**
 * 受管 HOME 下静态 settings 的内容（`<managedHome>/.iflow/settings.json`）。
 *
 * 只有一个键：认证类型钉死 openai-compatible（2026-04-16 日期开关后唯一可用的
 * headless 认证类型，调研 §5.2）。**三件套不落盘**：apiKey / baseUrl / modelName
 * 全走环境变量（CT() 的 `IFLOW_<大写下划线>` 形态，实测最小 settings + 纯 env
 * 三件套 headless 与 ACP 双路全通），密钥红线（§4.3）零妥协——settings 是静态
 * 常量文件，无按轮写盘、无竞态、无残留敏感值。
 *
 * 另一半理由：环境变量存在而 settings 无 selectedAuthType 时，CLI 会把 authType
 * 推成 `iflow` 类型撞上日期开关直接 deprecated（调研 §5.3）——这行 settings
 * 是让 env 三件套可用的**前提**，不是可选项。
 */
export const IFLOW_MANAGED_SETTINGS_JSON = `${JSON.stringify(
  { selectedAuthType: "openai-compatible" },
  null,
  2,
)}\n`;
