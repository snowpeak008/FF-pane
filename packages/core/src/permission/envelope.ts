/**
 * 权限信封计算（W1.4c，设计文档 §7 / §29）。
 *
 * 权限公式（v0.1 §29，v1.0 §7 精简为三层）：
 *   本次 Run 的最终权限 = 角色默认 ∩ 任务指定 ∩ 用户批准。
 * 交集只会变窄（v0.1 §23.6：委派只能缩小权限，不能自动扩大）；
 * 唯一的放宽通道是用户批准，且仅对当前 Run 有效（applyRunGrant）。
 *
 * 主要消费者：W2.7 权限执行层（Run 启动前算信封，运行期用裁决函数拦截）。
 */

import type {
  PermissionEnvelope,
  PermissionRequestPayload,
  Role,
  ShellPolicy,
} from "@ff-pane/shared";
import { normalizeCommandKey } from "./command.js";
import { intersectScopeLists, isPathAllowedByScopes, normalizePathKey } from "./paths.js";

/** §7 "项目内"的作用域写法：项目根整个子树。 */
export const PROJECT_WIDE_SCOPE = "**";

/**
 * Run 级信封 = 基础信封 + 本 Run 内用户逐条批准的 shell 命令白名单。
 * 单条命令批准无法用 ShellPolicy 三字面量表达，故以扩展字段承载；
 * 白名单条目为命令比较键（normalizeCommandKey 产物），只对当前 Run 有效。
 */
export interface RunEnvelope extends PermissionEnvelope {
  readonly grantedCommands: readonly string[];
}

function freezeEnvelope<T extends PermissionEnvelope>(envelope: T): T {
  Object.freeze(envelope.readPaths);
  Object.freeze(envelope.writePaths);
  const granted = (envelope as Partial<RunEnvelope>).grantedCommands;
  if (granted !== undefined) {
    Object.freeze(granted);
  }
  return Object.freeze(envelope);
}

/**
 * §7 角色默认表 —— Planner：
 * 可读项目内 / 不可写 / shell 禁止 / 网络允许（查资料）。
 */
export const PLANNER_DEFAULT_ENVELOPE: PermissionEnvelope = freezeEnvelope({
  readPaths: [PROJECT_WIDE_SCOPE],
  writePaths: [],
  shell: "forbidden",
  network: true,
  dangerousOpsRequireApproval: true,
});

/**
 * §7 角色默认表 —— Worker：
 * 可读项目内 / shell 允许（危险命令除外，见 classifyCommand）/ 网络默认禁止。
 *
 * writePaths 为"项目内"上限：§7 规定 Worker 实际可写范围是任务合同的
 * write_scope，该收窄由 intersectEnvelopes(角色默认, 任务信封) 完成——
 * 若上限设为空，任何任务与之相交后都恒为空，公式即失效。
 * 因此本常量不得单独作为最终信封使用，必须与任务信封相交。
 *
 * network 忠实于表格默认"禁止"；"任务可开"不走交集（false AND x 恒为 false），
 * 而是走用户批准通道：计划批准是用户动作（§6.1），任务开网因此有用户授权
 * 背书，W2.7 以 applyRunGrant(envelope, { kind: "network" }) 放宽当前 Run。
 */
export const WORKER_DEFAULT_ENVELOPE: PermissionEnvelope = freezeEnvelope({
  readPaths: [PROJECT_WIDE_SCOPE],
  writePaths: [PROJECT_WIDE_SCOPE],
  shell: "allowed",
  network: false,
  dangerousOpsRequireApproval: true,
});

/**
 * §7 角色默认表 —— Reviewer：
 * 可读项目内 / 不可写 / shell 仅验证命令（任务合同 verify_cmd，
 * 由 classifyCommand 的 verifyCommands 选项供给）/ 网络禁止。
 */
export const REVIEWER_DEFAULT_ENVELOPE: PermissionEnvelope = freezeEnvelope({
  readPaths: [PROJECT_WIDE_SCOPE],
  writePaths: [],
  shell: "verify_only",
  network: false,
  dangerousOpsRequireApproval: true,
});

/** §7 角色默认表（角色 → 默认信封）。 */
export const ROLE_DEFAULT_ENVELOPES: Readonly<Record<Role, PermissionEnvelope>> = Object.freeze({
  planner: PLANNER_DEFAULT_ENVELOPE,
  worker: WORKER_DEFAULT_ENVELOPE,
  reviewer: REVIEWER_DEFAULT_ENVELOPE,
});

/** Shell 策略宽松度：forbidden(0) < verify_only(1) < allowed(2)。 */
const SHELL_POLICY_PERMISSIVENESS: Readonly<Record<ShellPolicy, 0 | 1 | 2>> = Object.freeze({
  forbidden: 0,
  verify_only: 1,
  allowed: 2,
});

/** Shell 策略交集：最严者胜（禁止 < 仅验证 < 允许）。 */
export function intersectShellPolicies(a: ShellPolicy, b: ShellPolicy): ShellPolicy {
  return SHELL_POLICY_PERMISSIVENESS[a] <= SHELL_POLICY_PERMISSIVENESS[b] ? a : b;
}

/**
 * 权限信封交集（§29 公式的实现）。逐维取更窄：
 * - 路径作用域：intersectScopeLists（子路径关系判定，无法证明包含则空）；
 * - shell：最严者胜；
 * - 网络：AND；
 * - dangerousOpsRequireApproval：恒为 true（类型已锁，任何信封不能关闭）。
 * 返回新信封（冻结），不改动任何输入。
 */
export function intersectEnvelopes(
  first: PermissionEnvelope,
  ...rest: readonly PermissionEnvelope[]
): PermissionEnvelope {
  let acc: PermissionEnvelope = {
    readPaths: [...first.readPaths],
    writePaths: [...first.writePaths],
    shell: first.shell,
    network: first.network,
    dangerousOpsRequireApproval: true,
  };
  for (const next of rest) {
    acc = {
      readPaths: intersectScopeLists(acc.readPaths, next.readPaths),
      writePaths: intersectScopeLists(acc.writePaths, next.writePaths),
      shell: intersectShellPolicies(acc.shell, next.shell),
      network: acc.network && next.network,
      dangerousOpsRequireApproval: true,
    };
  }
  return freezeEnvelope(acc);
}

/** 裁决：信封是否放行对 path 的读取（供 W2.7 运行时调用）。 */
export function canRead(envelope: PermissionEnvelope, path: string): boolean {
  return isPathAllowedByScopes(envelope.readPaths, path);
}

/** 裁决：信封是否放行对 path 的写入（供 W2.7 运行时调用）。 */
export function canWrite(envelope: PermissionEnvelope, path: string): boolean {
  return isPathAllowedByScopes(envelope.writePaths, path);
}

/** envelope 是否已是 Run 级信封（携带命令白名单）。 */
export function isRunEnvelope(envelope: PermissionEnvelope): envelope is RunEnvelope {
  return Array.isArray((envelope as Partial<RunEnvelope>).grantedCommands);
}

/** 把基础信封提升为 Run 级信封（白名单初始为空；已是 Run 级则原样返回）。 */
export function toRunEnvelope(envelope: PermissionEnvelope): RunEnvelope {
  if (isRunEnvelope(envelope)) {
    return envelope;
  }
  return freezeEnvelope({
    readPaths: [...envelope.readPaths],
    writePaths: [...envelope.writePaths],
    shell: envelope.shell,
    network: envelope.network,
    dangerousOpsRequireApproval: true,
    grantedCommands: [],
  });
}

function widenScopes(
  scopes: readonly string[],
  rawPath: string,
  dimension: "read_path" | "write_path",
): readonly string[] {
  const key = normalizePathKey(rawPath);
  if (key === null) {
    throw new RangeError(
      `applyRunGrant(${dimension}): 路径 ${JSON.stringify(rawPath)} 不在项目内` +
        "（绝对路径 / ~ / 逃逸项目根）。信封只表达项目内作用域；" +
        "项目外访问的批准与危险操作同规格，由运行时拦截层（W2.7）逐次放行，不落入信封。",
    );
  }
  if (isPathAllowedByScopes(scopes, key)) {
    return scopes;
  }
  return [...scopes, key];
}

/**
 * 单次批准叠加（§7：批准仅对当前 Run 有效，不产生永久授权）。
 * 只放宽 grant 指定的那一个维度，返回新的 Run 级信封，绝不改动原件。
 *
 * - read_path / write_path：追加项目内作用域（已覆盖则不重复追加）；
 *   项目外路径无法落入信封 → 抛 RangeError，由运行时拦截层逐次放行。
 * - shell_command：命令比较键进入本 Run 白名单（不改变 shell 策略字面量；
 *   白名单命令仍要过危险命令判定，见 classifyCommand）。
 * - network：置为允许（信封的网络粒度为布尔，§7）。
 * - dangerous_operation：抛错。危险操作确认不产生任何豁免（§7 固定清单
 *   "不可被 Agent 申请豁免"），逐次放行属于运行时拦截层，信封不承载。
 */
export function applyRunGrant(
  envelope: PermissionEnvelope,
  grant: PermissionRequestPayload,
): RunEnvelope {
  const base = toRunEnvelope(envelope);
  switch (grant.kind) {
    case "read_path":
      return freezeEnvelope({
        ...base,
        readPaths: widenScopes(base.readPaths, grant.path, "read_path"),
      });
    case "write_path":
      return freezeEnvelope({
        ...base,
        writePaths: widenScopes(base.writePaths, grant.path, "write_path"),
      });
    case "shell_command": {
      const key = normalizeCommandKey(grant.command);
      const grantedCommands = base.grantedCommands.includes(key)
        ? base.grantedCommands
        : [...base.grantedCommands, key];
      return freezeEnvelope({ ...base, grantedCommands });
    }
    case "network":
      return freezeEnvelope({ ...base, network: true });
    case "dangerous_operation":
      throw new Error(
        "applyRunGrant(dangerous_operation): 危险操作不产生任何豁免（§7 固定清单，需逐次确认）；" +
          "用户的单次批准由运行时拦截层（W2.7）放行该一次操作，不落入信封。",
      );
  }
}
