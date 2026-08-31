/**
 * 各 Runtime 的探测命令与判定规则（W1.5d）。
 *
 * 全部为非交互的状态查询命令，绝不触发登录流程或打开浏览器。
 * 每条规则的依据（调研文档章节 / 真机实测）见各自注释；真机实测环境统一为
 * Windows 11 + PowerShell，2026-08-29，版本：codex-cli 0.147.0、
 * Claude Code 2.1.220、Gemini CLI 0.57.0、OpenCode 1.18.25。
 */

import { sanitizeOutputExcerpt, stripAnsi } from "./sanitize.js";
import type { CliLoginRuntime, CliLoginStatus, CompletedExecution } from "./types.js";

/** 单个 Runtime 的探测规则。 */
export interface RuntimeProbeRule {
  /** 探测命令（可执行文件名，不含参数）。 */
  readonly command: string;
  /** 命令参数。 */
  readonly args: readonly string[];
  /** 对已完成的执行结果做判定，返回结论与人类可读依据。 */
  readonly evaluate: (execution: CompletedExecution) => {
    status: CliLoginStatus;
    detail: string;
  };
}

/** 组装"退出码 + 输出摘录"的通用 detail 后缀（摘录已脱敏）。 */
function describeExecution(execution: CompletedExecution): string {
  const excerpt = sanitizeOutputExcerpt(
    [execution.stdout, execution.stderr].filter((part) => part.trim() !== "").join(" | "),
  );
  const output = excerpt === "" ? "（无输出）" : excerpt;
  return `退出码 ${execution.exitCode}，输出：${output}`;
}

/**
 * codex：`codex login status`
 *
 * 依据 docs/adapters/codex.md §5：已登录输出 "Logged in using ChatGPT"、
 * 退出码 0；未登录输出 "Not logged in"、退出码 1；仅设 OPENAI_API_KEY
 * 环境变量不构成登录态（登录态以 $CODEX_HOME/auth.json 为准）。
 * 真机实测补充（0.147.0）：状态文本走 stderr 而非 stdout，退出码判定不受影响。
 * 判定：退出码 0 → logged_in；1 → logged_out；其他 → unknown。
 */
const codexRule: RuntimeProbeRule = {
  command: "codex",
  args: ["login", "status"],
  evaluate(execution) {
    if (execution.exitCode === 0) {
      return { status: "logged_in", detail: describeExecution(execution) };
    }
    if (execution.exitCode === 1) {
      return { status: "logged_out", detail: describeExecution(execution) };
    }
    return {
      status: "unknown",
      detail: `非预期退出码（预期 0=已登录 / 1=未登录）。${describeExecution(execution)}`,
    };
  },
};

/**
 * claude-code：`claude auth status`
 *
 * 依据 docs/adapters/claude-code.md §7：该命令输出 JSON
 * `{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}`。
 * 真机实测补充（2.1.220）：输出为多行美化 JSON、走 stdout；已登录退出码 0 +
 * loggedIn:true；未登录（以 CLAUDE_CONFIG_DIR 指向空目录实测）退出码 1 +
 * loggedIn:false。
 * 判定：以 JSON 的 loggedIn 字段为准（对多行输出做正则提取，不依赖整体
 * JSON.parse——CLI 可能在 JSON 前后混入告警文本）；提取不到 → unknown。
 */
const claudeCodeRule: RuntimeProbeRule = {
  command: "claude",
  args: ["auth", "status"],
  evaluate(execution) {
    const combined = stripAnsi(`${execution.stdout}\n${execution.stderr}`);
    const match = /"loggedIn"\s*:\s*(true|false)/.exec(combined);
    if (match) {
      return {
        status: match[1] === "true" ? "logged_in" : "logged_out",
        detail: describeExecution(execution),
      };
    }
    return {
      status: "unknown",
      detail: `输出中未找到 loggedIn 字段。${describeExecution(execution)}`,
    };
  },
};

/**
 * gemini-cli：`gemini --list-sessions`
 *
 * Gemini CLI 0.57.0 无专用的登录态查询子命令（docs/adapters/gemini-cli.md §6
 * 建议探测 ~/.gemini/oauth_creds.json 文件，但本模块统一走命令探测）。
 * 借用会话枚举命令：依据 docs/adapters/gemini-cli.md §2 退出码表与 §4，
 * `--list-sessions` 要求认证，无认证退出码 41（FatalAuthenticationError）。
 * 真机实测补充（0.57.0，未登录）：退出码 41 + "Please set an Auth method…"
 * 提示文本，纯打印即退出，不触发浏览器或交互登录。
 * 判定：退出码 0 → logged_in；41 → logged_out；其他（如 55=目录未信任、
 * HTTP 状态码直通的 4xx/5xx）→ unknown。
 * 注意：GEMINI_API_KEY 等环境变量会让该命令在无 OAuth 登录态时也成功——
 * cli_login 语义只认 CLI 自管凭证，生产执行器已剥离相关变量（见 executor.ts）。
 */
const geminiCliRule: RuntimeProbeRule = {
  command: "gemini",
  args: ["--list-sessions"],
  evaluate(execution) {
    if (execution.exitCode === 0) {
      return { status: "logged_in", detail: describeExecution(execution) };
    }
    if (execution.exitCode === 41) {
      return { status: "logged_out", detail: describeExecution(execution) };
    }
    return {
      status: "unknown",
      detail: `非预期退出码（预期 0=已登录 / 41=认证失败）。${describeExecution(execution)}`,
    };
  },
};

/**
 * opencode：`opencode auth list`
 *
 * OpenCode 无全局"登录态"，凭证按 Provider 存于 ~/.local/share/opencode/auth.json
 * （docs/adapters/opencode.md §4.4：cli_login 探测 auth.json 是否含 provider）。
 * `opencode auth list`（alias ls）列出已存凭证，真机实测补充（1.18.25）：
 * 退出码恒 0，输出含 ANSI 色码的 "Credentials <auth.json 路径>" 表头与
 * "N credentials" 计数行（无凭证时为 "0 credentials"）。
 * 判定：剥 ANSI 后匹配计数行，N≥1 → logged_in（存在至少一个 CLI 自管凭证）；
 * N=0 → logged_out；非零退出码或找不到计数行 → unknown。
 */
const opencodeRule: RuntimeProbeRule = {
  command: "opencode",
  args: ["auth", "list"],
  evaluate(execution) {
    const combined = stripAnsi(`${execution.stdout}\n${execution.stderr}`);
    const match = /(\d+)\s+credentials?\b/i.exec(combined);
    if (execution.exitCode === 0 && match?.[1] !== undefined) {
      const count = Number.parseInt(match[1], 10);
      return {
        status: count > 0 ? "logged_in" : "logged_out",
        detail: `已存凭证 ${count} 个。${describeExecution(execution)}`,
      };
    }
    return {
      status: "unknown",
      detail: `未能解析凭证计数行（预期 "N credentials"）。${describeExecution(execution)}`,
    };
  },
};

/**
 * grok-build：`grok models`
 *
 * grok 1.0.13 无登录态查询子命令（`grok login` 会真的发起登录，不能拿来探测）。
 * 借用模型枚举命令，真机实测（未登录）：**退出码恒为 0**，但 stdout 首行是
 * "You are not authenticated."，其后照常打印内置模型清单。
 * 判定只能看文本：未登录标记出现 → logged_out；退出码 0 且无该标记 → logged_in；
 * 非零退出码 → unknown。
 * 注意：`XAI_API_KEY` 会让 grok 视作已认证——cli_login 语义只认 CLI 自管凭证，
 * 生产执行器已剥离 API key 类环境变量（见 executor.ts）。
 */
const grokBuildRule: RuntimeProbeRule = {
  command: "grok",
  args: ["models"],
  evaluate(execution) {
    const combined = stripAnsi(`${execution.stdout}\n${execution.stderr}`);
    if (/not authenticated|not signed in/i.test(combined)) {
      return { status: "logged_out", detail: describeExecution(execution) };
    }
    if (execution.exitCode === 0) {
      return { status: "logged_in", detail: describeExecution(execution) };
    }
    return {
      status: "unknown",
      detail: `非零退出码且无未登录标记。${describeExecution(execution)}`,
    };
  },
};

/** Runtime → 探测规则映射。 */
export const PROBE_RULES: Readonly<Record<CliLoginRuntime, RuntimeProbeRule>> = Object.freeze({
  codex: codexRule,
  "claude-code": claudeCodeRule,
  "gemini-cli": geminiCliRule,
  opencode: opencodeRule,
  "grok-build": grokBuildRule,
});
