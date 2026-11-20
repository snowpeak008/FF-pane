/**
 * Claude 执行窗口的项目内沙盒（T11.20，Tony 2026-11-21 定）。纯函数，开窗时用。
 *
 * 可改可跑命令（edit-exec）的 Claude 窗口在 Windows 上用 Claude 自带的沙盒：命令以 `srt-sandbox` 账户运行，
 * 只能写项目、和项目外可写目录；只能连名单里的域名。实测结论见 docs/全放开与执行窗口权限计划.md §5.1：
 * - Windows 沙盒还没正式开放，要内部开关 CLAUDE_CODE_NANKEEN_KESTREL=1（Tony 定用它）；
 * - 要 Claude Code ≥ 2.1.329，并设 `sandbox.windows.backend: "sandboxuser"`；
 * - `autoAllowBashIfSandboxed` 在 Windows 上不起作用，命令不问靠 `--allowedTools PowerShell,Bash`，
 *   放行后命令仍在沙盒里跑；
 * - `failIfUnavailable`：沙盒起不来就退出，不悄悄变成不受限。
 * 其他档、其他 CLI 不用这里。
 */

import type { WorkbenchPermissionLevel } from "@ff-pane/shared";
import { sandboxNetworkDomainsFor } from "@ff-pane/shared";

/** 打开 Claude Windows 沙盒的内部开关（没写进官方文档；只放进这个窗口的进程环境）。 */
export const CLAUDE_SANDBOX_GATE_ENV = "CLAUDE_CODE_NANKEEN_KESTREL";

/** 能用 `sandboxuser` 后端、和已装的沙盒（安装标记第 3 版）对得上的最低版本。 */
export const CLAUDE_SANDBOX_MIN_VERSION = "2.1.329";

/** Claude 跑命令的两个工具。Windows 上实际用 PowerShell，装了 Git Bash 时也可能用 Bash。 */
export const CLAUDE_SANDBOX_COMMAND_TOOLS: readonly string[] = ["PowerShell", "Bash"];

/** Claude 沙盒起不来时在终端里打的话（2.1.302 / 2.1.329 实测）。 */
const STARTUP_FAILURE = /sandbox required but unavailable:\s*([^\r\n]*)/i;
/** 终端颜色码（CSI 序列）。用字符码拼，免得正则字面量里出现控制字符。 */
const CSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

/** 这个窗口要不要上沙盒：只有 Windows 上 edit-exec 档的 Claude（含 DeepSeek 那一路）。 */
export function usesClaudeSandbox(input: {
  readonly runtime: string;
  readonly permission: WorkbenchPermissionLevel;
  readonly platform?: NodeJS.Platform;
}): boolean {
  return (
    input.runtime === "claude-code" &&
    input.permission === "edit-exec" &&
    (input.platform ?? process.platform) === "win32"
  );
}

/**
 * 写进这个窗口 `--settings` 的 `sandbox` 一段。
 * 项目目录（工作目录）默认就能写，不用列；allowWrite 只放项目外可写目录。
 */
export function claudeSandboxSettings(input: {
  readonly outsideDirs: readonly string[];
  readonly extraDomains?: readonly string[];
}): Record<string, unknown> {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    // Windows 上暂时不起作用（官方写明只管 macOS 和 Linux），留着免得以后支持了还要改
    autoAllowBashIfSandboxed: true,
    windows: { backend: "sandboxuser" },
    filesystem: { allowWrite: [...input.outsideDirs] },
    network: {
      allowedDomains: [...sandboxNetworkDomainsFor(input.extraDomains)],
      strictAllowlist: true,
    },
  };
}

/** `claude --version` 的输出里取版本号，比如 `2.1.329 (Claude Code)`。认不出返回 undefined。 */
export function parseClaudeVersion(output: string): string | undefined {
  return /(\d+)\.(\d+)\.(\d+)/.exec(output)?.[0];
}

/** a 比 b 新返回正数，一样返回 0，旧返回负数。只比三段数字。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index++) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export type ClaudeSandboxCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "version" | "not-installed"; readonly message: string };

/** 开窗前的检查结果。版本认不出时不拦：交给 failIfUnavailable 在启动时兜底。 */
export function judgeClaudeSandbox(input: {
  readonly version: string | undefined;
  readonly installed: boolean;
}): ClaudeSandboxCheck {
  if (
    input.version !== undefined &&
    compareVersions(input.version, CLAUDE_SANDBOX_MIN_VERSION) < 0
  ) {
    return {
      ok: false,
      reason: "version",
      message: `Claude Code 版本太旧（${input.version}），项目内沙盒要 ${CLAUDE_SANDBOX_MIN_VERSION} 或更新，可改可跑命令的 Claude 窗口开不了。关掉 FF-pane 后在 PowerShell 里运行 npm i -g @anthropic-ai/claude-code@latest，再重开窗口；或者把这个窗口改成全放开（只在你确定时）。`,
    };
  }
  if (!input.installed) {
    return {
      ok: false,
      reason: "not-installed",
      message:
        "Claude 沙盒没装，可改可跑命令的 Claude 窗口开不了。在 PowerShell 里运行 claude sandbox install（会弹一次管理员确认）后重开窗口；或者把这个窗口改成全放开（只在你确定时）。",
    };
  }
  return { ok: true };
}

/** 终端输出里有没有「沙盒起不来」那句；有就返回 Claude 给的原因（可能为空串）。 */
export function detectSandboxStartupFailure(output: string): string | undefined {
  const match = STARTUP_FAILURE.exec(output.replace(CSI_SEQUENCE, ""));
  return match === null ? undefined : (match[1] ?? "").trim();
}

/** 沙盒起不来时告诉用户 / 上级的话。 */
export function sandboxStartupFailureMessage(reason: string): string {
  return `Claude 沙盒没起来，这个可改可跑命令的窗口按设定直接退出了（不会不受限地跑）。Claude 给的原因：${reason === "" ? "（没写）" : reason}。常见办法：把 Claude Code 升到最新（npm i -g @anthropic-ai/claude-code@latest），或在 PowerShell 里重跑 claude sandbox install；都不行时可以先把这个窗口改成全放开。`;
}
