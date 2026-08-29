/**
 * Gemini CLI 退出码语义表（W2.5）。
 *
 * 权威依据：docs/adapters/gemini-cli.md §2 的退出码表（源码逐一确认）+ 本机真机复核
 * （无认证 `-p ... -o stream-json` → 退出码 41，stdout 无任何 JSON）。
 *
 * 核心约束（调研 §8.4 坑 2）：**退出码不可枚举**——API 错误的 HTTP 状态码会直接成为
 * 进程退出码（真机见 400）。因此本表只负责"把认识的码翻译成人话"，不负责判定成败，
 * 也绝不把未知码规整成某个已知值：原始码一律原样进 EndEvent.exitCode。
 */

/** 成功。 */
export const GEMINI_EXIT_OK = 0;
/** 一般错误。 */
export const GEMINI_EXIT_GENERAL_ERROR = 1;
/** 认证失败（FatalAuthenticationError）。 */
export const GEMINI_EXIT_AUTH_FAILURE = 41;
/** 输入错误（FatalInputError）。 */
export const GEMINI_EXIT_INPUT_ERROR = 42;
/** 沙箱错误。 */
export const GEMINI_EXIT_SANDBOX_ERROR = 44;
/** 配置错误。 */
export const GEMINI_EXIT_CONFIG_ERROR = 52;
/** 超过会话轮数上限（settings `model.maxSessionTurns`）。 */
export const GEMINI_EXIT_MAX_TURNS = 53;
/** 工具执行致命错误。 */
export const GEMINI_EXIT_TOOL_FATAL = 54;
/** 未信任目录（缺 `--skip-trust`）。 */
export const GEMINI_EXIT_UNTRUSTED_WORKSPACE = 55;
/** 取消（FatalCancellationError；仅 TTY 下 CLI 自己装取消监听）。 */
export const GEMINI_EXIT_CANCELLED = 130;

/**
 * 已知退出码 → 人类可读说明（进 EndEvent.message，供 Run 报告与 UI 展示）。
 * 说明里带上"下一步怎么办"，因为这些码在 FF-pane 里几乎都对应一个具体的配置动作。
 */
export const GEMINI_EXIT_CODE_MEANINGS: Readonly<Record<number, string>> = Object.freeze({
  [GEMINI_EXIT_GENERAL_ERROR]: "Gemini CLI 报一般错误（未细分类别），详见 stderr 原始日志",
  [GEMINI_EXIT_AUTH_FAILURE]:
    "Gemini CLI 认证失败：未提供可用凭证。请在 Provider 中配置 GEMINI_API_KEY 后按 Run 注入，" +
    "或改用 Vertex AI（GOOGLE_GENAI_USE_VERTEXAI）/ 已登录的 Google 账号（GOOGLE_GENAI_USE_GCA）",
  [GEMINI_EXIT_INPUT_ERROR]: "Gemini CLI 报输入错误：启动参数或提示词不被接受",
  [GEMINI_EXIT_SANDBOX_ERROR]: "Gemini CLI 沙箱启动失败（FF-pane 默认不启用 -s/--sandbox）",
  [GEMINI_EXIT_CONFIG_ERROR]:
    "Gemini CLI 报配置错误：settings.json 或 --policy 策略文件不被接受（策略文件语法错误也走此码）",
  [GEMINI_EXIT_MAX_TURNS]:
    "本次会话超过轮数上限（settings model.maxSessionTurns）：任务过大或模型陷入循环，建议拆分任务",
  [GEMINI_EXIT_TOOL_FATAL]: "工具执行致命错误：某次工具调用把 CLI 直接带崩",
  [GEMINI_EXIT_UNTRUSTED_WORKSPACE]:
    "工作目录未被信任（缺 --skip-trust）：属适配器装配错误，正常启动参数必带该开关",
  [GEMINI_EXIT_CANCELLED]: "Gemini CLI 报取消（FatalCancellationError）",
});

/** HTTP 状态码区间：Gemini API 错误会把状态码直接当退出码（真机见 400）。 */
const HTTP_STATUS_MIN = 400;
const HTTP_STATUS_MAX = 599;

/**
 * 把退出码翻译成人类可读说明。
 * 返回 undefined 仅有两种情况：退出码为 0（成功无需解释）或为 null（被信号杀死/未起来，
 * 此时该由进程终局的 error 字段说明）。
 */
export function describeGeminiExitCode(exitCode: number | null): string | undefined {
  if (exitCode === null || exitCode === GEMINI_EXIT_OK) {
    return undefined;
  }
  const known = GEMINI_EXIT_CODE_MEANINGS[exitCode];
  if (known !== undefined) {
    return `退出码 ${exitCode}：${known}`;
  }
  if (exitCode >= HTTP_STATUS_MIN && exitCode <= HTTP_STATUS_MAX) {
    return (
      `退出码 ${exitCode}：Gemini API 以 HTTP ${exitCode} 失败` +
      "（Gemini CLI 把 API 错误的 HTTP 状态码直接作为进程退出码）"
    );
  }
  return `退出码 ${exitCode}：Gemini CLI 未列入语义表的失败（退出码不可枚举，见调研 §2）`;
}
