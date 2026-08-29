/**
 * Codex CLI 命令行组装（W2.3）。
 *
 * 全部参数取自 docs/adapters/codex.md §1.2 并以本机 `codex exec --help` /
 * `codex exec resume --help`（0.147.0）复核。三条不可省的默认项：
 * - `--json`：stdout 变 JSONL 事件流，适配器的唯一输入；
 * - `-C <cwd>`：指定 Agent 工作根（**只有首轮有此参数**，见下）；
 * - `--skip-git-repo-check`：否则非 git 目录直接拒绝启动（§7.4）。
 *
 * resume 与首轮的参数集不同（0.147.0 实测 `exec resume` 的选项表里没有
 * `-C/--cd`、`--add-dir`、`-s/--sandbox`）：
 * - 工作根只能靠**子进程自身的 cwd**，故 spawn 时必须以 ctx.cwd 为 cwd，
 *   且 ctx.resume.cwd 与 ctx.cwd 不一致时应在启动前快速失败（见 adapter.ts）；
 * - 沙箱策略不继承首轮命令行（codex.md §3），须用 `-c sandbox_mode=...` 重给；
 * - `--add-dir` 无对应 `-c` 开关，resume 轮只能省略（默认 bypass 策略下无影响）。
 *
 * 提示词一律走 `--` 之后的位置参数：本机实测 `codex exec ... -- "<prompt>"`
 * 解析正常，这样以 `-` 开头的提示词（`-` 本身还意味着"从 stdin 读"，§1.1）
 * 不会被当成选项。
 */

import type { ModelId, NativeSessionBinding, RuntimeId } from "@ff-pane/shared";

/** Runtime 注册键（adapter.ts KNOWN_RUNTIMES 之一）。 */
export const CODEX_RUNTIME: RuntimeId = "codex";

/** 默认可执行文件名（npm 全局安装落地为 codex.cmd 垫片，由 process 层处理）。 */
export const DEFAULT_CODEX_COMMAND = "codex";

/**
 * 沙箱参数策略。
 *
 * 默认 `bypass`（`--dangerously-bypass-approvals-and-sandbox`）的依据是
 * codex.md §7.3 坑 1：Windows 原生沙箱不可用（`-s workspace-write` 在 %TEMP%
 * 实测报 `windows sandbox: helper_unknown_error: apply deny-read ACLs`），
 * 且失败后 turn 照样 `turn.completed`——即"开着沙箱"换来的是随机失败而不是
 * 安全。**安全由 FF-pane 权限层承担（W2.7）**：写路径拦截、越界写检测与审批
 * 都在 FF-pane 侧做，Codex 侧只求行为确定性。
 * 其余三值透传给 CLI，供非 Windows 平台或用户显式选择时使用。
 */
export const CODEX_SANDBOX_POLICIES = [
  "bypass",
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

/** 沙箱参数策略。 */
export type CodexSandboxPolicy = (typeof CODEX_SANDBOX_POLICIES)[number];

/** 默认沙箱策略（论证见 CODEX_SANDBOX_POLICIES）。 */
export const DEFAULT_CODEX_SANDBOX_POLICY: CodexSandboxPolicy = "bypass";

/** buildCodexArgs 的输入。 */
export interface CodexArgsInput {
  /** Agent 工作根。首轮经 `-C` 下发；resume 轮只能靠子进程 cwd。 */
  readonly cwd: string;
  /** 本轮提示词（`--` 之后的位置参数）。 */
  readonly prompt: string;
  /** 指定模型（`-m`）；缺席用 Runtime/Profile 默认。 */
  readonly model?: ModelId | undefined;
  /** 原生会话绑定；缺席 = 开新会话。 */
  readonly resume?: NativeSessionBinding | undefined;
  /** 沙箱策略，默认 DEFAULT_CODEX_SANDBOX_POLICY。 */
  readonly sandbox?: CodexSandboxPolicy | undefined;
  /** `-c key=value` 配置覆盖（成本控制如 `model_reasoning_effort="low"`）。 */
  readonly configOverrides?: Readonly<Record<string, string>> | undefined;
  /** `--add-dir` 额外可写目录（对应任务合同 write_scope 多路径；resume 轮不支持）。 */
  readonly addDirs?: readonly string[] | undefined;
  /** 原样追加的参数（逃生门，接在生成参数之后、提示词之前）。 */
  readonly extraArgs?: readonly string[] | undefined;
}

/** 沙箱参数：首轮用 `-s`，resume 轮只能用 `-c sandbox_mode=`（codex.md §3）。 */
function sandboxArgs(policy: CodexSandboxPolicy, resuming: boolean): string[] {
  if (policy === "bypass") {
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }
  return resuming ? ["-c", `sandbox_mode="${policy}"`] : ["-s", policy];
}

/**
 * 组装 `codex exec` / `codex exec resume` 的参数表（不含可执行文件本身）。
 * 纯函数，参数顺序稳定，便于单测与日志比对。
 */
export function buildCodexArgs(input: CodexArgsInput): string[] {
  const resuming = input.resume !== undefined;
  const args: string[] = resuming
    ? ["exec", "resume", input.resume?.nativeSessionId ?? ""]
    : ["exec"];

  args.push("--json", "--skip-git-repo-check");
  if (!resuming) {
    args.push("-C", input.cwd);
  }
  args.push(...sandboxArgs(input.sandbox ?? DEFAULT_CODEX_SANDBOX_POLICY, resuming));
  if (input.model !== undefined && input.model !== "") {
    args.push("-m", input.model);
  }
  for (const [key, value] of Object.entries(input.configOverrides ?? {})) {
    args.push("-c", `${key}=${value}`);
  }
  if (!resuming) {
    for (const dir of input.addDirs ?? []) {
      args.push("--add-dir", dir);
    }
  }
  args.push(...(input.extraArgs ?? []));
  args.push("--", input.prompt);
  return args;
}
