/**
 * 命令分类（W1.4c，供 W2.7 权限执行层调用）。
 *
 * 判定顺序：
 * 1. Shell 策略闸门（forbidden / verify_only / allowed + 本 Run 已批准命令
 *    白名单）→ 不放行 → denied；
 * 2. 危险命令扫描（§7 固定清单内置规则 + 可配置追加规则 + write_scope 删除
 *    目标分析）→ 命中 → needs_approval（危险操作永远需用户逐次确认，白名单
 *    批准也不豁免）；
 * 3. 其余 → allowed。
 *
 * 本模块是命令字符串层面的启发式预判，方向恒为宁严勿松：解析不出目标的
 * 删除命令、引号里的可疑内容都按危险处理，误报的代价只是多一次用户确认。
 * 文件系统级的精确拦截（真实读写路径核对）由 W2.7 在运行时执行。
 */

import type { DangerousOperation, PermissionEnvelope } from "@ff-pane/shared";
import { createLiteralGuard } from "@ff-pane/shared";
import type { RunEnvelope } from "./envelope.js";
import { isPathAllowedByScopes, isPatternCoveredByScopes } from "./paths.js";

/** 命令裁决结果字面量。 */
export const COMMAND_VERDICTS = ["allowed", "needs_approval", "denied"] as const;

/** 命令裁决结果。 */
export type CommandVerdict = (typeof COMMAND_VERDICTS)[number];

/** CommandVerdict 运行时守卫。 */
export const isCommandVerdict = createLiteralGuard(COMMAND_VERDICTS);

/**
 * 危险命令规则。pattern 对归一化命令行（trim、空白折叠、反斜杠折算为正斜杠）
 * 执行 test；请勿使用 g 标志（会残留 lastIndex），大小写不敏感请加 i。
 */
export interface DangerousCommandRule {
  /** 规则标识（审计与测试用）。 */
  readonly id: string;
  /** 匹配模式。 */
  readonly pattern: RegExp;
  /** 命中映射到的危险操作类别（§7 固定清单）。 */
  readonly operation: DangerousOperation;
}

/**
 * §7 危险操作固定清单的内置命令规则（不可移除，只能通过 extraRules 追加）。
 * delete_outside_write_scope 需要对照信封 writePaths，不在静态规则内，
 * 由 classifyCommand 的删除目标分析承担。
 */
export const BUILTIN_DANGEROUS_COMMAND_RULES: readonly DangerousCommandRule[] = Object.freeze([
  {
    id: "git-push",
    operation: "git_push",
    pattern: /\bgit(?:\.exe)?\s+(?:[^;&|]*\s)?push\b/i,
  },
  {
    id: "git-dir",
    operation: "modify_git_dir",
    pattern: /(?:^|[\s"'=/])\.git(?:$|[\s"'/])/i,
  },
  {
    id: "credential-ssh-dir",
    operation: "read_credential_paths",
    pattern: /(?:^|[\s"'=/])\.ssh(?:$|[\s"'/])/i,
  },
  {
    id: "credential-env-file",
    operation: "read_credential_paths",
    pattern: /(?:^|[\s"'=/])\.env(?:$|[\s"'./])/i,
  },
  {
    id: "credential-key-file",
    operation: "read_credential_paths",
    pattern: /\bid_(?:rsa|dsa|ecdsa|ed25519)\b|\.(?:pem|ppk)\b/i,
  },
  {
    id: "credential-config",
    operation: "read_credential_paths",
    pattern: /(?:^|[\s"'=/])\.(?:netrc|npmrc|pypirc|aws|gnupg|kube)(?:$|[\s"'/])/i,
  },
  {
    id: "system-package-manager",
    operation: "install_system_software",
    pattern:
      /\b(?:winget|choco|scoop|brew|apt-get|apt|aptitude|yum|dnf|pacman|zypper)(?:\.exe)?\s+(?:[^\s;&|]+\s+)*?install\b|\bmsiexec\b/i,
  },
  {
    id: "global-node-install",
    operation: "install_system_software",
    pattern:
      /\b(?:npm|pnpm|yarn|bun)(?:\.exe)?\s+(?:(?:[^;&|]*\s)?(?:-g|--global)(?:\s|$)|global\s+add\b)/i,
  },
  {
    id: "package-publish",
    operation: "publish_or_deploy",
    pattern: /\b(?:npm|pnpm|yarn|bun)(?:\.exe)?\s+(?:[^\s;&|]+\s+)*?publish\b/i,
  },
  {
    id: "container-push",
    operation: "publish_or_deploy",
    pattern: /\bdocker(?:\.exe)?\s+(?:[^\s;&|]+\s+)*?push\b/i,
  },
  {
    id: "release-deploy-cli",
    operation: "publish_or_deploy",
    pattern:
      /\bgh\s+release\b|\b(?:vercel|netlify|firebase|flyctl|fly|wrangler|railway|heroku|eas|amplify|serverless|sst|cdk)\s+(?:[^\s;&|]+\s+)*?(?:deploy|publish)\b|\b(?:terraform|kubectl)\s+(?:[^\s;&|]+\s+)*?apply\b|\bhelm\s+(?:[^\s;&|]+\s+)*?(?:install|upgrade)\b/i,
  },
] satisfies readonly DangerousCommandRule[]);

/** classifyCommand 选项。 */
export interface ClassifyCommandOptions {
  /**
   * shell = verify_only 时放行的验证命令（任务合同 verify_cmd）。
   * 与命令做比较键（normalizeCommandKey）整串比对。
   */
  readonly verifyCommands?: readonly string[];
  /** 追加的危险命令模式（内置固定清单不可移除，只增不减）。 */
  readonly extraRules?: readonly DangerousCommandRule[];
}

/** 命令分类结果（reason 供审批 UI 与审计日志展示）。 */
export interface CommandClassification {
  readonly verdict: CommandVerdict;
  /** 命中的危险操作类别（去重；可能多个，如删 .git 同时命中两类）。 */
  readonly dangerousOperations: readonly DangerousOperation[];
  /** 命中的规则 id（含内置与追加；删除目标分析记为 delete-outside-write-scope）。 */
  readonly matchedRules: readonly string[];
  /** 人类可读的判定依据。 */
  readonly reason: string;
}

/**
 * 命令比较键：trim + 连续空白折叠为单空格。区分大小写（批准即所批那一条），
 * 用于 Run 白名单与 verify_cmd 的整串比对。
 */
export function normalizeCommandKey(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/** 删除类命令名（含 PowerShell Remove-Item 及别名 ri）。 */
const DELETE_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "rm",
  "del",
  "erase",
  "rmdir",
  "rd",
  "unlink",
  "rimraf",
  "remove-item",
  "ri",
  "shred",
]);

/** 包装器命令：其后才出现真正要执行的命令名。 */
const COMMAND_WRAPPER_NAMES: ReadonlySet<string> = new Set([
  "sudo",
  "doas",
  "npx",
  "pnpx",
  "bunx",
  "cmd",
  "powershell",
  "pwsh",
  "bash",
  "sh",
  "zsh",
  "start",
  "call",
]);

/** 以未加引号的 ; & | 与换行切分子命令（引号内的分隔符不生效）。 */
function splitSubCommands(command: string): readonly string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of command) {
    if (quote !== null) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || char === "&" || char === "|" || char === "\n") {
      if (current.trim() !== "") {
        parts.push(current);
      }
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "") {
    parts.push(current);
  }
  return parts;
}

/** 按空白切词，保留引号内空白（引号本身剥除）。 */
function tokenize(subCommand: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of subCommand) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current !== "") {
    tokens.push(current);
  }
  return tokens;
}

/** 取命令名主体：去目录前缀与常见可执行扩展名，小写。 */
function commandBaseName(token: string): string {
  const lowered = token.toLowerCase().replaceAll("\\", "/");
  const base = lowered.slice(lowered.lastIndexOf("/") + 1);
  return base.replace(/\.(?:exe|cmd|bat|com|ps1)$/, "");
}

/** 标志 token：-x / --xx / PowerShell -Param / Windows 单字母开关（/f /s /q…）。 */
function isFlagToken(token: string): boolean {
  return token.startsWith("-") || /^\/[a-z?]{1,3}$/i.test(token);
}

/** 环境变量赋值前缀（FOO=bar cmd …）。 */
function isEnvAssignment(token: string): boolean {
  return /^[a-z_][a-z0-9_]*=/i.test(token);
}

/**
 * 删除命令目标提取（启发式，宁严勿松）。
 * 返回 null ＝ 本段没有删除命令；返回数组 ＝ 删除目标（可能为空，空表示
 * 有删除命令但目标解析不出，调用方应按危险处理）。
 * 引号包裹的完整子命令（如 powershell -Command "rm x"）会递归分析。
 */
function extractDeleteTargets(tokens: readonly string[]): readonly string[] | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      break;
    }
    if (/\s/.test(token)) {
      const nested = extractDeleteTargets(tokenize(token));
      if (nested !== null) {
        return nested;
      }
      continue;
    }
    const base = commandBaseName(token);
    if (DELETE_COMMAND_NAMES.has(base)) {
      return tokens.slice(index + 1).filter((candidate) => !isFlagToken(candidate));
    }
    if (COMMAND_WRAPPER_NAMES.has(base) || isFlagToken(token) || isEnvAssignment(token)) {
      continue;
    }
    return null;
  }
  return null;
}

/** 单个删除目标是否可证明落在 writePaths 内（证明不了 → 视为越界）。 */
function deleteTargetInsideWriteScope(writePaths: readonly string[], target: string): boolean {
  if (/[*?]/.test(target)) {
    return isPatternCoveredByScopes(writePaths, target);
  }
  return isPathAllowedByScopes(writePaths, target);
}

/** 是否存在超出 write_scope 的删除（§7 固定清单第 1 项）。 */
function hasDeleteOutsideWriteScope(command: string, writePaths: readonly string[]): boolean {
  for (const subCommand of splitSubCommands(command)) {
    const targets = extractDeleteTargets(tokenize(subCommand));
    if (targets === null) {
      continue;
    }
    if (targets.length === 0) {
      return true;
    }
    if (targets.some((target) => !deleteTargetInsideWriteScope(writePaths, target))) {
      return true;
    }
  }
  return false;
}

function grantedCommandsOf(envelope: PermissionEnvelope): readonly string[] {
  const candidate = (envelope as Partial<RunEnvelope>).grantedCommands;
  return Array.isArray(candidate) ? candidate : [];
}

/**
 * 命令裁决（供 W2.7 运行时调用）：allowed / needs_approval / denied。
 * 判定顺序见文件头。传入 RunEnvelope 时，本 Run 白名单命令可越过策略闸门，
 * 但危险命令判定不受白名单豁免（§7：危险操作需用户逐次确认）。
 */
export function classifyCommand(
  envelope: PermissionEnvelope,
  command: string,
  options: ClassifyCommandOptions = {},
): CommandClassification {
  const key = normalizeCommandKey(command);
  const granted = grantedCommandsOf(envelope).includes(key);

  let policyAllowed: boolean;
  let policyReason: string;
  if (granted) {
    policyAllowed = true;
    policyReason = "命令已获本 Run 用户逐条批准";
  } else if (envelope.shell === "allowed") {
    policyAllowed = true;
    policyReason = "shell 策略为 allowed";
  } else if (envelope.shell === "verify_only") {
    const verifyKeys = (options.verifyCommands ?? []).map(normalizeCommandKey);
    policyAllowed = verifyKeys.includes(key);
    policyReason = policyAllowed
      ? "shell 策略为 verify_only，命中任务合同的验证命令"
      : "shell 策略为 verify_only，且命令不是任务合同的验证命令";
  } else {
    policyAllowed = false;
    policyReason = "shell 策略为 forbidden";
  }

  const matchTarget = key.replaceAll("\\", "/");
  const rules = [...BUILTIN_DANGEROUS_COMMAND_RULES, ...(options.extraRules ?? [])];
  const operations = new Set<DangerousOperation>();
  const matchedRules: string[] = [];
  for (const rule of rules) {
    if (rule.pattern.test(matchTarget)) {
      operations.add(rule.operation);
      matchedRules.push(rule.id);
    }
  }
  if (hasDeleteOutsideWriteScope(key, envelope.writePaths)) {
    operations.add("delete_outside_write_scope");
    matchedRules.push("delete-outside-write-scope");
  }
  const dangerousOperations = [...operations];

  let verdict: CommandVerdict;
  let reason: string;
  if (!policyAllowed) {
    verdict = "denied";
    reason =
      dangerousOperations.length > 0
        ? `${policyReason}；且命中危险操作：${dangerousOperations.join("、")}`
        : policyReason;
  } else if (dangerousOperations.length > 0) {
    verdict = "needs_approval";
    reason = `命中危险操作（§7 固定清单，需用户逐次确认）：${dangerousOperations.join("、")}`;
  } else {
    verdict = "allowed";
    reason = policyReason;
  }

  return Object.freeze({
    verdict,
    dangerousOperations: Object.freeze(dangerousOperations),
    matchedRules: Object.freeze(matchedRules),
    reason,
  });
}
