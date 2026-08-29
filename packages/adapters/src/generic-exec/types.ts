/**
 * generic-exec（L2 通用单次命令接入）的配置类型（W2.2）。
 *
 * 定位（设计文档 §5.2）：任意 CLI 一进一出——「stdin/参数 传入任务文本 →
 * 进程运行 → stdout 收集结果 → 进程结束」。没有事件协议、没有会话延续，
 * 因此本适配器只承担 Worker 小任务或一次性问答，不做 Planner。
 *
 * 配置由用户在设置页填写（W3.2）并持久化为 JSON，故本文件的所有类型都必须是
 * 纯 JSON 可序列化形态：不含函数、不含 Buffer、不含类实例。
 */

import { createLiteralGuard } from "@ff-pane/shared";

/** 本适配器的 Runtime 注册键（KNOWN_RUNTIMES 之一）。 */
export const GENERIC_EXEC_RUNTIME = "generic-exec";

/**
 * 任务文本占位符。**只在 args 数组的元素内部做值替换**，不参与 command、
 * 不参与 env、更不拼进任何 shell 命令串——这是本适配器的防注入基线，
 * 详见 config.ts 的 renderGenericExecArgs。
 */
export const TASK_PLACEHOLDER = "{task}";

/**
 * 任务文本的投递方式（二选一）：
 * - argv：替换 args 模板里的 {task} 占位符。适合短任务，命令行可读、可复现；
 * - stdin：args 保持原样，任务文本经子进程 stdin 写入并即刻 EOF。长文本必须走
 *   这条路——Windows 下 npm 全局 CLI 多为 .cmd 垫片，W2.1a 需经
 *   `cmd.exe /d /s /c` 执行，整串命令行有 8191 字符硬上限
 *   （见 WINDOWS_CMD_SHIM_COMMAND_LINE_LIMIT）。
 */
export const GENERIC_EXEC_TASK_DELIVERIES = ["argv", "stdin"] as const;

/** 任务文本投递方式。 */
export type GenericExecTaskDelivery = (typeof GENERIC_EXEC_TASK_DELIVERIES)[number];

/** GenericExecTaskDelivery 运行时守卫（读入持久化配置时校验）。 */
export const isGenericExecTaskDelivery = createLiteralGuard(GENERIC_EXEC_TASK_DELIVERIES);

/**
 * stdout 的解读方式：
 * - text：整段 stdout 就是答案，不做任何解析（默认，也是 L2 的常态）；
 * - jsonl：额外把每一行按 JSON 逐行解析并以 `raw` 事件透传留档（答案文本照旧给出）。
 *   给"输出恰好是 JSONL 但还没有专用 L1 适配器"的新 CLI 一个过渡位：原生事件
 *   进得了 Run 的原始日志，未来写 L1 适配器时有真实样本可依。
 */
export const GENERIC_EXEC_OUTPUT_FORMATS = ["text", "jsonl"] as const;

/** stdout 解读方式。 */
export type GenericExecOutputFormat = (typeof GENERIC_EXEC_OUTPUT_FORMATS)[number];

/** GenericExecOutputFormat 运行时守卫。 */
export const isGenericExecOutputFormat = createLiteralGuard(GENERIC_EXEC_OUTPUT_FORMATS);

/**
 * 工作目录策略：
 * - turn：用本轮 ctx.cwd（项目工作目录）。默认，也是权限层裁决路径的基准；
 * - fixed：固定绝对路径。给"必须在自己安装目录里跑"的工具留的逃生口——
 *   代价是 Agent 看不到项目文件，只能当纯问答工具。
 */
export const GENERIC_EXEC_CWD_MODES = ["turn", "fixed"] as const;

/** 工作目录策略判别值。 */
export type GenericExecCwdMode = (typeof GENERIC_EXEC_CWD_MODES)[number];

/** GenericExecCwdMode 运行时守卫。 */
export const isGenericExecCwdMode = createLiteralGuard(GENERIC_EXEC_CWD_MODES);

/** 工作目录策略。 */
export type GenericExecCwdStrategy =
  | { readonly mode: "turn" }
  | { readonly mode: "fixed"; readonly path: string };

/**
 * Windows 下 `cmd.exe /d /s /c "…"` 的整串命令行硬上限（字符）。
 * W2.1a 对 .cmd/.bat 垫片走此路径，且参数要做双层 `^` 转义（含元字符的文本会
 * 明显膨胀），故这只是理论天花板，不是可用预算。
 */
export const WINDOWS_CMD_SHIM_COMMAND_LINE_LIMIT = 8191;

/**
 * argv 模式下渲染后参数的总长度预算（字符），超出即快速失败并提示改用 stdin。
 *
 * 取 8000 而非 8191：给转义膨胀与命令路径留头。故意**不按平台区分**——同一份
 * 配置在 macOS 上能跑、拿到 Windows 上却报 8191，是最难排查的一类问题；
 * 用统一的保守预算换配置可移植性。需要更长 argv 的场景把本项设为 0（不限）。
 *
 * 注意这是"预检"而非精确模型：元字符密集的文本双层转义后仍可能突破真实上限。
 * 长文本的正解始终是 taskDelivery: "stdin"。
 */
export const DEFAULT_ARGV_LENGTH_LIMIT = 8000;

/** stderr 的捕获上限（字符）。超限后仍继续读流（背压约定），只是不再累积。 */
export const DEFAULT_STDERR_CAPTURE_LIMIT = 64 * 1024;

/** end.message 中 stderr 摘录的最大长度（字符）。 */
export const END_MESSAGE_EXCERPT_LENGTH = 500;

/**
 * generic-exec 适配器配置。
 *
 * 与 AdapterTurnContext 的分工：**配置是"怎么跑这个 CLI"（用户填一次），
 * ctx 是"这一轮跑什么"（每轮变化）**。冲突项的优先级在各字段注释里逐一说明。
 */
export interface GenericExecConfig {
  /** 命令名或绝对路径（Windows 下由 W2.1a 做 PATH × PATHEXT 解析与 .cmd 垫片处理）。 */
  readonly command: string;
  /**
   * 参数模板数组。元素内的 {task} 会被本轮任务文本**整体值替换**
   * （argv 模式），不做分词、不做 shell 拼接。
   * 空数组合法（有些工具只读 stdin）。
   */
  readonly args: readonly string[];
  /** 任务文本投递方式。 */
  readonly taskDelivery: GenericExecTaskDelivery;
  /** 工作目录策略，缺省 { mode: "turn" }。 */
  readonly cwd?: GenericExecCwdStrategy;
  /**
   * 用户配置的环境变量。与本轮 ctx.env 合并，**ctx.env 优先**——Run 级密钥
   * 注入（设计文档 §4.3 的唯一密钥通道）不该被一份静态配置盖掉。
   * 注入表内的名字免于 API key 清洗（W2.1a 语义：注入优先）。
   */
  readonly env?: Readonly<Record<string, string>>;
  /** 本轮超时毫秒，缺省不限时。ctx.timeoutMs 优先于本项。 */
  readonly timeoutMs?: number;
  /** stdout 解读方式，缺省 "text"。 */
  readonly outputFormat?: GenericExecOutputFormat;
  /**
   * 是否剥离 API key 类环境变量，缺省 true。
   *
   * **设为 false 的风险**（W2.1a env.ts 的动机）：子进程会继承用户 shell 里的
   * 全部 Provider 凭证，于是这个 CLI 实际用的 Provider/模型可能与 FF-pane 的
   * Profile 配置不一致，且计费落在用户的全局密钥上——Run 记录会与事实不符。
   * 只在"该 CLI 只认自己的登录态、且该登录态由环境变量承载"时才关闭。
   */
  readonly stripApiKeyEnv?: boolean;
  /** argv 总长度预算，缺省 DEFAULT_ARGV_LENGTH_LIMIT；0 表示不限。 */
  readonly argvLengthLimit?: number;
  /** stderr 捕获上限（字符），缺省 DEFAULT_STDERR_CAPTURE_LIMIT。 */
  readonly stderrCaptureLimit?: number;
  /** 界面显示名，缺省由 command 生成。 */
  readonly displayName?: string;
}
