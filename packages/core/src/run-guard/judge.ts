/**
 * 运行期裁决（W2.7a）：写路径与命令的事前拦截。
 *
 * 这是"事前拦截 + 事后审计"双保险的事前半边。三家 CLI 的权限拒绝会伪装成成功
 *（T2.0），所以每一次写文件、每一条命令都必须先过这里，而不是相信 Runtime
 * 自己的沙箱回执。
 *
 * 裁决顺序（写路径，先硬拒后审批）：
 * 1. 项目外路径 → violation（恒拒，无审批通道：信封只表达项目内作用域，
 *    §7 的批准通道也只能追加项目内作用域）；
 * 2. 命中任务合同 forbidden 派生的禁写模式 → violation（恒拒：Planner 在合同里
 *    写明禁止的事，Worker 不能靠自己申请批准绕开）；
 * 3. delete 且目标超出信封 writePaths → needs_approval（§7 危险操作固定清单第 1 项，
 *    须用户逐次确认；先于普通写路径判定，避免一次 write_path 批准顺带放过删除）；
 * 4. 其余超出 writePaths 的写入 → needs_approval（§7 权限扩展请求 write_path）；
 * 5. 放行。
 *
 * 命令裁决包装 W1.4c 的 classifyCommand（策略闸门 + 危险命令扫描 + 删除目标分析），
 * 只负责把三态映射为本层裁决并生成送审载荷。
 */

import type { DangerousOperation, PermissionRequestPayload } from "@ff-pane/shared";
import type { ClassifyCommandOptions } from "../permission/index.js";
import { canWrite, classifyCommand, isPathAllowedByScopes } from "../permission/index.js";
import { resolveRunPath } from "./resolve.js";
import type {
  CommandJudgeInput,
  CommandJudgement,
  FileChangeJudgeInput,
  FileChangeJudgement,
  RunFileChangeKind,
  RunGuardTarget,
} from "./types.js";

const NO_DANGEROUS_OPERATIONS: readonly DangerousOperation[] = Object.freeze([]);

const DELETE_OUTSIDE_WRITE_SCOPE: readonly DangerousOperation[] = Object.freeze([
  "delete_outside_write_scope",
]);

const CHANGE_KIND_LABELS: Readonly<Record<RunFileChangeKind, string>> = Object.freeze({
  add: "新建",
  update: "修改",
  delete: "删除",
});

function fileTarget(
  path: string,
  changeKind: RunFileChangeKind,
  projectPath?: string,
): RunGuardTarget {
  return projectPath === undefined
    ? { kind: "file_change", path, changeKind }
    : { kind: "file_change", path, changeKind, projectPath };
}

function renderScopes(scopes: readonly string[]): string {
  return scopes.length === 0 ? "（无）" : `[${scopes.join(", ")}]`;
}

/**
 * 写路径裁决。envelope 应为 assembleRunEnvelope 的产物（已含用户批准），
 * forbiddenPaths 与 cwd 由同一次装配 / 编排层提供。
 */
export function judgeFileChange(input: FileChangeJudgeInput): FileChangeJudgement {
  const { envelope, path, changeKind } = input;
  const label = CHANGE_KIND_LABELS[changeKind];
  const resolution = resolveRunPath(path, input.cwd);
  if (!resolution.inProject) {
    const judgement: FileChangeJudgement = {
      decision: "violation",
      violation: {
        code: "path_outside_project",
        target: fileTarget(path, changeKind),
        reason: `${label}的目标在项目外，恒拒：${resolution.reason}`,
        dangerousOperations: NO_DANGEROUS_OPERATIONS,
      },
    };
    return Object.freeze(judgement);
  }

  const projectPath = resolution.key;
  const forbiddenPaths = input.forbiddenPaths ?? [];
  if (isPathAllowedByScopes(forbiddenPaths, projectPath)) {
    const judgement: FileChangeJudgement = {
      decision: "violation",
      violation: {
        code: "forbidden_path",
        target: fileTarget(path, changeKind, projectPath),
        reason:
          `${label}的目标 ${projectPath} 命中任务合同 forbidden 的禁写模式 ` +
          `${renderScopes(forbiddenPaths)}，恒拒（合同禁止项不可由 Agent 申请豁免）`,
        dangerousOperations: NO_DANGEROUS_OPERATIONS,
      },
    };
    return Object.freeze(judgement);
  }

  const writable = canWrite(envelope, projectPath);
  const writeScopeText = renderScopes(envelope.writePaths);
  if (changeKind === "delete" && !writable) {
    const judgement: FileChangeJudgement = {
      decision: "needs_approval",
      projectPath,
      request: {
        kind: "dangerous_operation",
        operation: "delete_outside_write_scope",
        detail: `删除 ${projectPath}`,
      },
      reason:
        `删除 ${projectPath} 超出本 Run 可写范围 ${writeScopeText}，` +
        "属 §7 危险操作固定清单第 1 项，需用户逐次确认",
      dangerousOperations: DELETE_OUTSIDE_WRITE_SCOPE,
    };
    return Object.freeze(judgement);
  }
  if (!writable) {
    const judgement: FileChangeJudgement = {
      decision: "needs_approval",
      projectPath,
      request: { kind: "write_path", path: projectPath },
      reason:
        `${label} ${projectPath} 超出本 Run 可写范围 ${writeScopeText}，` +
        "需用户批准 write_path 扩展（仅当前 Run 有效）",
      dangerousOperations: NO_DANGEROUS_OPERATIONS,
    };
    return Object.freeze(judgement);
  }

  const judgement: FileChangeJudgement = {
    decision: "allowed",
    projectPath,
    reason: `${label} ${projectPath} 在本 Run 可写范围内`,
  };
  return Object.freeze(judgement);
}

/** 合并任务合同的单条 verify_cmd 与额外白名单，得到 verify_only 的放行清单。 */
function verifyCommandsOf(input: CommandJudgeInput): readonly string[] {
  const fromContract = input.verifyCmd === undefined ? [] : [input.verifyCmd];
  return [...fromContract, ...(input.verifyCommands ?? [])];
}

/**
 * 命令裁决。violation 对应 classifyCommand 的 denied（shell 策略闸门未放行），
 * 仍附带 shell_command 送审载荷——策略闸门是可由用户逐条批准打开的；
 * needs_approval 对应命中 §7 危险操作固定清单，载荷取首个危险类别，
 * 完整类别列表在 classification.dangerousOperations 里（编排层需逐条确认）。
 */
export function judgeCommand(input: CommandJudgeInput): CommandJudgement {
  const options: ClassifyCommandOptions = {
    verifyCommands: verifyCommandsOf(input),
    ...(input.extraDangerousRules === undefined ? {} : { extraRules: input.extraDangerousRules }),
  };
  const classification = classifyCommand(input.envelope, input.command, options);
  const target: RunGuardTarget = { kind: "command", command: input.command };

  if (classification.verdict === "allowed") {
    const judgement: CommandJudgement = {
      decision: "allowed",
      classification,
      reason: classification.reason,
    };
    return Object.freeze(judgement);
  }

  if (classification.verdict === "denied") {
    const judgement: CommandJudgement = {
      decision: "violation",
      classification,
      violation: {
        code: "command_denied",
        target,
        reason: classification.reason,
        dangerousOperations: classification.dangerousOperations,
      },
      request: { kind: "shell_command", command: input.command },
    };
    return Object.freeze(judgement);
  }

  // needs_approval：策略闸门放行但命中危险操作。危险类别缺席在 classifyCommand
  // 的语义下不可能发生（needs_approval 必有危险类别），兜底退回命令级送审。
  const [operation] = classification.dangerousOperations;
  const request: PermissionRequestPayload =
    operation === undefined
      ? { kind: "shell_command", command: input.command }
      : { kind: "dangerous_operation", operation, detail: input.command };
  const judgement: CommandJudgement = {
    decision: "needs_approval",
    classification,
    request,
    reason: classification.reason,
  };
  return Object.freeze(judgement);
}
