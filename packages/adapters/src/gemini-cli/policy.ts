/**
 * 每 Run 的 Gemini CLI 策略引擎 TOML 生成器（W2.5，纯函数）。
 *
 * 为什么需要它：Worker 必须 `--approval-mode yolo` 才能干活（headless 下 default 会
 * 拒掉一切写操作、auto_edit 仍拒 shell，调研 §3.4），而 yolo 等于 CLI 侧完全放权。
 * 于是设计文档 §7 的五项权限只能由 FF-pane 外层承担，`--policy` 是其中成本最低、
 * 又能在 CLI 内部生效的一层（调研 §8.3 建议 1）：把信封与危险清单编译成 deny 规则，
 * 危险动作在工具执行前就被拒，不必等事后校验。
 *
 * 与 core 的 classifyCommand（W1.4c）的关系：两者**规则同源、形态不同，故不复用**。
 * ① 本包依赖方向只到 @ff-pane/shared，core 不可依赖；② classifyCommand 对"归一化命令行"
 * 判定并可给出 needs_approval，而这里要对 Gemini 策略引擎的"稳定 JSON 参数串"写正则，
 * 且 headless 下只有 deny 可用（ask_user 一律视同 deny，官方文档明示）。两者是纵深防御的
 * 两层：本层在 CLI 内先拒，W2.7 在 FF-pane 侧裁决与事后校验。
 *
 * 四条实现要点（全部来自 0.57.0 安装包源码 + 本机真机复核，非推测）：
 * 1. **优先级取上限 999**。`--policy` 指定的路径会被记入 `userProvidedPaths` 并强制提到
 *    USER 层（base 4，真机复核：策略报错前缀就是 `[USER]`），因此任何优先级都已压过内置
 *    yolo.toml 的 allow-all（DEFAULT 层 `priority = 998` → 1.998）。仍取 999 是为了万一
 *    未来版本改回按目录判层（落 DEFAULT 层时 1.999 才压得住 1.998）。调研 §8.3 样例里的
 *    900 只在非 yolo 模式下够用，此处按源码上调。
 * 2. **只生成 deny 规则**，一律同优先级。放行由 `--approval-mode` 承担；同级全 deny，
 *    命中顺序不影响结果，避免依赖引擎内部的同优先级排序。
 * 3. `argsPattern` 匹配的是 `stableStringify(args)`：键名按字典序、**每个顶层键值对被
 *    NUL 字符包裹**（源码 `pairStr = "\0" + pairStr + "\0"`）。故所有模式以
 *    `(?:\x00|[{,])"key":"` 定界（NUL 不在时退回 `{`/`,`，边界仍成立，不会被参数值里的
 *    伪造键名骗过），值内部用 `[^\x00]*` 跨越 JSON 转义（`\"` 不会截断匹配）。
 * 4. **必须过 CLI 的 ReDoS 检查**（`isSafeRegExp`，见 isGeminiSafePolicyRegExp）：不合格的
 *    规则被 CLI **整条丢弃**（stderr 一行 `[USER] Policy file error`，进程照跑），等于该条
 *    防护静默失效——首版实现就在真机复核中被打回 4 条。故本模块的模式一律不在 `)` 后接
 *    量词，且生成时做自检，不合格立即抛错而不是交出一份"看着有规则、实际不生效"的策略。
 */

import type { DangerousOperation, PermissionEnvelope } from "@ff-pane/shared";
import {
  GEMINI_EDIT_TOOL_NAMES,
  GEMINI_NETWORK_TOOL_NAMES,
  GEMINI_SHELL_TOOL_NAME,
} from "./native.js";

/** 策略引擎的三值决定（本生成器只用 deny，另两值供类型完整与测试断言）。 */
export const GEMINI_POLICY_DECISIONS = ["allow", "deny", "ask_user"] as const;

/** 策略决定。 */
export type GeminiPolicyDecision = (typeof GEMINI_POLICY_DECISIONS)[number];

/**
 * 生成规则统一使用的优先级：TOML 允许 0..999，取上限压过内置 yolo allow-all（998）。
 * 见文件头要点 1。
 */
export const GEMINI_POLICY_OVERRIDE_PRIORITY = 999;

/** 内置 yolo.toml 的 allow-all 优先级（源码常量，用于说明与回归断言）。 */
export const GEMINI_YOLO_ALLOW_ALL_PRIORITY = 998;

/** argsPattern 长度上限（CLI 的 isSafeRegExp 硬限制）。 */
export const GEMINI_POLICY_PATTERN_MAX_LENGTH = 2048;

/**
 * 复刻 CLI 的 `isSafeRegExp(pattern)`（0.57.0 源码逐行等价）：不合格的 argsPattern 会被
 * 静默丢规则。三条判据——能编译、长度 ≤ 2048、不含"组内量词 + 组后量词"的嵌套量词形态。
 *
 * 注意第三条极其宽泛：只要模式里出现过 `(`…量词…`)` 且**任何**位置有 `)` 紧跟量词就算不安全，
 * 所以本模块所有模式都用字符类量词（`[^\x00]*`）而非分组量词（`(?:…)?`）。
 */
export function isGeminiSafePolicyRegExp(pattern: string): boolean {
  try {
    new RegExp(pattern);
  } catch {
    return false;
  }
  if (pattern.length > GEMINI_POLICY_PATTERN_MAX_LENGTH) {
    return false;
  }
  return !/\([^)]*[*+?{].*\)[*+?{]/.test(pattern);
}

/** 生成的策略规则不被 CLI 接受（属装配错误，由适配器转为 end(failed)）。 */
export class GeminiPolicyError extends Error {
  override readonly name = "GeminiPolicyError";
}

/** 一条策略规则（字段名严格对齐 0.57.0 的 TOML rule schema）。 */
export interface GeminiPolicyRule {
  /** 规则来源标识（FF-pane 自用：渲染为 TOML 注释、供单测断言，不进引擎）。 */
  readonly id: string;
  readonly toolName: string | readonly string[];
  readonly decision: GeminiPolicyDecision;
  readonly priority: number;
  /** 对稳定 JSON 参数串的正则；缺席 = 全局规则（deny 时该工具对模型完全隐藏）。 */
  readonly argsPattern?: string;
  /** 拒绝文案（回传给模型与用户，解释为什么被拒）。 */
  readonly denyMessage?: string;
  /** 命中的设计文档 §7 危险操作类别（若该规则源自危险清单）。 */
  readonly operation?: DangerousOperation;
  /** 规则意图说明（渲染为 TOML 注释）。 */
  readonly note: string;
}

/** 生成器输入。 */
export interface GeminiPolicyInput {
  /** Run 的最终权限信封（角色默认 ∩ 任务指定 ∩ 用户批准，由 core 算好）。 */
  readonly envelope: PermissionEnvelope;
  /**
   * 项目根（= 子进程 cwd）。写作用域是相对项目根的 glob（shared 的 PermissionEnvelope
   * 约定），而事件与工具参数里的 file_path 是绝对路径，故必须有根才能编译出路径片段。
   */
  readonly projectRoot: string;
  /** shell = verify_only 时放行的验证命令（任务合同 verify_cmd）。 */
  readonly verifyCommands?: readonly string[];
  /** 策略文件头注释里标注的 Run/任务标识（可选，仅为排障可溯源）。 */
  readonly label?: string;
}

/** §7 "项目内"作用域写法（与 core 的 PROJECT_WIDE_SCOPE 同义，此处不跨包引用）。 */
const PROJECT_WIDE_SCOPE = "**";

/** 危险操作 → 拒绝文案（统一口径：headless 无审批通道，只能拒，让用户回 FF-pane 确认）。 */
function denyMessageFor(operation: DangerousOperation, detail: string): string {
  return `FF-pane 拒绝：${detail}属于危险操作（${operation}），需用户在 FF-pane 中逐次确认；Gemini CLI 非交互模式无审批通道，故一律拒绝。`;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 顶层参数键的定界前缀（见文件头要点 3）。 */
function argKeyPrefix(key: string): string {
  return `(?:\\x00|[{,])"${escapeRegex(key)}":"`;
}

/** 字符串参数值内部的"任意字符"：跨 JSON 转义，但不跨顶层键值对边界。 */
const VALUE_BODY = "[^\\x00]*";

/**
 * 单引号在正则里一律写成 `\x27`：如此本模块的所有 argsPattern 必然能用 TOML
 * literal string（`'...'`）承载——那种字面量不做任何转义，反斜杠满地的正则最不容易写错。
 */
const SINGLE_QUOTE = "\\x27";

/** run_shell_command 的 command 值内含某模式即命中。 */
function shellCommandPattern(body: string): string {
  return `${argKeyPrefix("command")}${VALUE_BODY}(?:${body})`;
}

/** 文件路径类参数（file_path）值内含某模式即命中。 */
function filePathPattern(body: string): string {
  return `${argKeyPrefix("file_path")}${VALUE_BODY}(?:${body})`;
}

/**
 * 把路径片段编译成正则：分隔符归一为 `[\\/]+`。
 * 之所以是 `+`：JSON 序列化后 Windows 的单个 `\` 是两个字符（`\\`），一个字符类配不上。
 */
function pathFragmentPattern(fragment: string): string {
  return fragment
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "")
    .map(escapeRegex)
    .join("[\\\\/]+");
}

/** glob 里第一个通配符之前的字面前缀（`src/**` → `src`、`docs/api/*.md` → `docs/api`）。 */
function literalPrefixOf(scope: string): string {
  const normalized = scope.replaceAll("\\", "/");
  const wildcardAt = normalized.search(/[*?[\]{}]/);
  const literal = wildcardAt === -1 ? normalized : normalized.slice(0, wildcardAt);
  const lastSlash = literal.lastIndexOf("/");
  return wildcardAt === -1 || lastSlash === -1 ? literal : literal.slice(0, lastSlash);
}

/**
 * 写作用域 → 允许的绝对路径片段（粗粒度，调研 §8.3 明示"可实现 write_scope 粗粒度限制"）。
 * "项目内"（`**`）编译为项目根本身：yolo 下 CLI 不拦项目外写入，这条把它拦住。
 */
function writeScopeFragments(input: GeminiPolicyInput): readonly string[] {
  const root = input.projectRoot;
  const fragments = new Set<string>();
  for (const scope of input.envelope.writePaths) {
    const prefix = scope === PROJECT_WIDE_SCOPE ? "" : literalPrefixOf(scope);
    fragments.add(prefix === "" ? root : `${root.replace(/[\\/]+$/, "")}/${prefix}`);
  }
  return [...fragments];
}

/**
 * 危险命令模式（与 core BUILTIN_DANGEROUS_COMMAND_RULES 同源，改写为 JSON 串形态）。
 *
 * 写法约束（要点 4）：**不得在 `)` 后接量词**，"命令名 … 关键字"一律写成
 * `\b名字\b[^\x00;&|]*\s关键字\b` —— `[^\x00;&|]*` 既跨过中间的参数，又不跨过 `;`/`&`/`|`
 * （那已是另一条子命令）与顶层键值对边界。代价是比 core 的规则更宽（`git log --grep push`
 * 也会被拦），方向与 core 一致：宁严勿松，误报只多一次用户确认。
 */
const DANGEROUS_SHELL_BODIES: readonly {
  readonly id: string;
  readonly operation: DangerousOperation;
  readonly detail: string;
  readonly body: string;
}[] = [
  {
    id: "shell-git-push",
    operation: "git_push",
    detail: "git push",
    body: "\\bgit\\b[^\\x00;&|]*\\spush\\b",
  },
  {
    id: "shell-git-dir",
    operation: "modify_git_dir",
    detail: "改动 .git 目录",
    body: `\\.git(?:[/\\s"${SINGLE_QUOTE}]|\\\\\\\\)`,
  },
  {
    id: "shell-credential-paths",
    operation: "read_credential_paths",
    detail: "读取密钥/凭证类路径",
    body:
      "(?:\\.ssh|\\.env|\\.netrc|\\.npmrc|\\.pypirc|\\.aws|\\.gnupg|\\.kube)" +
      `(?:[/\\s"${SINGLE_QUOTE}.]|\\\\\\\\|$)` +
      "|\\bid_(?:rsa|dsa|ecdsa|ed25519)\\b|\\.(?:pem|ppk)\\b",
  },
  {
    id: "shell-system-install",
    operation: "install_system_software",
    detail: "安装系统级软件",
    body:
      "\\b(?:winget|choco|scoop|brew|apt-get|apt|aptitude|yum|dnf|pacman|zypper)\\b" +
      "[^\\x00;&|]*\\sinstall\\b|\\bmsiexec\\b" +
      "|\\b(?:npm|pnpm|yarn|bun)\\b[^\\x00;&|]*\\s-g\\b" +
      "|\\b(?:npm|pnpm|yarn|bun)\\b[^\\x00;&|]*\\s--global\\b" +
      "|\\b(?:npm|pnpm|yarn|bun)\\b[^\\x00;&|]*\\sglobal\\sadd\\b",
  },
  {
    id: "shell-publish-deploy",
    operation: "publish_or_deploy",
    detail: "发布或部署",
    body:
      "\\b(?:npm|pnpm|yarn|bun)\\b[^\\x00;&|]*\\spublish\\b" +
      "|\\bdocker\\b[^\\x00;&|]*\\spush\\b|\\bgh\\b[^\\x00;&|]*\\srelease\\b" +
      "|\\b(?:vercel|netlify|firebase|flyctl|fly|wrangler|railway|heroku|eas|amplify|serverless|sst|cdk)\\b" +
      "[^\\x00;&|]*\\s(?:deploy|publish)\\b" +
      "|\\b(?:terraform|kubectl)\\b[^\\x00;&|]*\\sapply\\b" +
      "|\\bhelm\\b[^\\x00;&|]*\\s(?:install|upgrade)\\b",
  },
  {
    id: "shell-recursive-delete",
    operation: "delete_outside_write_scope",
    detail: "递归强制删除",
    // 粗粒度：删除目标能否落在 write_scope 内无法用正则可靠判定（core 的
    // hasDeleteOutsideWriteScope 才做得到），故这里只拦"递归 + 强制"这一类
    // 一旦越界即不可逆的形态，其余删除交 W2.7 运行时裁决与事后校验。
    body:
      "\\b(?:rm|del|erase|rimraf)\\b[^\\x00;&|]*\\s--?[a-z]*[rf]" +
      "|\\bRemove-Item\\b[^\\x00;&|]*-Recurse|\\bRemove-Item\\b[^\\x00;&|]*-Force" +
      "|\\b(?:rmdir|rd)\\b[^\\x00;&|]*/[sq]",
  },
];

/** 危险清单里同样适用于文件编辑工具的两类（写 .git、写凭证文件）。 */
const DANGEROUS_PATH_BODIES: readonly {
  readonly id: string;
  readonly operation: DangerousOperation;
  readonly detail: string;
  readonly body: string;
}[] = [
  {
    id: "path-git-dir",
    operation: "modify_git_dir",
    detail: "写入 .git 目录",
    body: `\\.git(?:[/\\s"${SINGLE_QUOTE}]|\\\\\\\\)`,
  },
  {
    id: "path-credential-file",
    operation: "read_credential_paths",
    detail: "写入密钥/凭证类文件",
    body:
      "(?:\\.ssh|\\.env|\\.netrc|\\.npmrc|\\.pypirc|\\.aws|\\.gnupg|\\.kube)" +
      `(?:[/\\s"${SINGLE_QUOTE}.]|\\\\\\\\|")` +
      '|\\bid_(?:rsa|dsa|ecdsa|ed25519)\\b|\\.(?:pem|ppk)"',
  },
];

/**
 * 信封 + 危险清单 → deny 规则集。
 *
 * 生成顺序（仅影响 TOML 可读性，不影响裁决）：危险清单 → 写作用域 → shell 策略 → 网络。
 */
export function buildGeminiPolicyRules(input: GeminiPolicyInput): readonly GeminiPolicyRule[] {
  const rules = collectGeminiPolicyRules(input);
  for (const rule of rules) {
    // 自检（要点 4）：不合格的模式会被 CLI 整条丢弃且只在 stderr 留一行，
    // 那是"以为有防护、其实没有"的静默失效——宁可在 Run 启动时就响。
    if (rule.argsPattern !== undefined && !isGeminiSafePolicyRegExp(rule.argsPattern)) {
      throw new GeminiPolicyError(
        `策略规则 ${rule.id} 的 argsPattern 不满足 Gemini CLI 的 isSafeRegExp 检查` +
          `（会被静默丢弃）：${rule.argsPattern}`,
      );
    }
  }
  return rules;
}

function collectGeminiPolicyRules(input: GeminiPolicyInput): readonly GeminiPolicyRule[] {
  const rules: GeminiPolicyRule[] = [];
  const priority = GEMINI_POLICY_OVERRIDE_PRIORITY;

  // 1. 危险操作固定清单（§7 第 5 项：dangerousOpsRequireApproval 类型恒为 true，
  //    任何信封都关不掉，故无条件生成）。
  for (const rule of DANGEROUS_SHELL_BODIES) {
    rules.push({
      id: rule.id,
      toolName: GEMINI_SHELL_TOOL_NAME,
      decision: "deny",
      priority,
      argsPattern: shellCommandPattern(rule.body),
      denyMessage: denyMessageFor(rule.operation, rule.detail),
      operation: rule.operation,
      note: `危险命令拦截：${rule.detail}`,
    });
  }
  for (const rule of DANGEROUS_PATH_BODIES) {
    rules.push({
      id: rule.id,
      toolName: [...GEMINI_EDIT_TOOL_NAMES],
      decision: "deny",
      priority,
      argsPattern: filePathPattern(rule.body),
      denyMessage: denyMessageFor(rule.operation, rule.detail),
      operation: rule.operation,
      note: `危险路径拦截：${rule.detail}`,
    });
  }

  // 2. 写作用域（§7 第 2 项）。空 = 不可写：全局 deny 让编辑工具对模型完全隐藏
  //    （policy-engine.md：无 argsPattern 的 deny 会把工具从模型可见列表里摘掉）。
  if (input.envelope.writePaths.length === 0) {
    rules.push({
      id: "write-forbidden",
      toolName: [...GEMINI_EDIT_TOOL_NAMES],
      decision: "deny",
      priority,
      denyMessage: "FF-pane 拒绝：本次 Run 的权限信封不含任何可写路径（只读角色）。",
      note: "写作用域为空：编辑类工具整体禁用",
    });
  } else {
    const fragments = writeScopeFragments(input).map(pathFragmentPattern);
    rules.push({
      id: "write-scope",
      toolName: [...GEMINI_EDIT_TOOL_NAMES],
      decision: "deny",
      priority,
      // 负向前查：file_path 里找不到任何一个允许片段就拒。粗粒度（包含而非前缀匹配），
      // 精确越界判定由 W2.7 事后校验兜底（调研 §8.3 建议 2）。
      argsPattern: `${argKeyPrefix("file_path")}(?!${VALUE_BODY}(?:${fragments.join("|")}))`,
      denyMessage:
        "FF-pane 拒绝：目标文件不在本次 Run 的可写作用域内（write_scope）；" +
        "如确需写入，请在 FF-pane 中扩大任务的 write_scope 并重跑。",
      note: `写作用域限制（允许片段：${writeScopeFragments(input).join("、")}）`,
    });
  }

  // 3. shell 策略（§7 第 3 项）。
  if (input.envelope.shell === "forbidden") {
    rules.push({
      id: "shell-forbidden",
      toolName: GEMINI_SHELL_TOOL_NAME,
      decision: "deny",
      priority,
      denyMessage: "FF-pane 拒绝：本次 Run 的 shell 策略为 forbidden（如 Planner 角色）。",
      note: "shell 策略 forbidden：命令执行工具整体禁用",
    });
  } else if (input.envelope.shell === "verify_only") {
    const verifyCommands = input.verifyCommands ?? [];
    if (verifyCommands.length === 0) {
      rules.push({
        id: "shell-verify-only-empty",
        toolName: GEMINI_SHELL_TOOL_NAME,
        decision: "deny",
        priority,
        denyMessage:
          "FF-pane 拒绝：本次 Run 的 shell 策略为 verify_only，且任务合同未给出验证命令。",
        note: "shell 策略 verify_only 且验证命令为空：命令执行工具整体禁用",
      });
    } else {
      const prefixes = verifyCommands.map((command) =>
        escapeRegex(JSON.stringify(command).slice(1, -1)),
      );
      rules.push({
        id: "shell-verify-only",
        toolName: GEMINI_SHELL_TOOL_NAME,
        decision: "deny",
        priority,
        // 负向前查：命令不以任一验证命令开头就拒（整串前缀比对，与 core 的
        // verify_cmd 语义一致；后接空白或引号，避免 `pnpm test` 放行 `pnpm testx`）。
        argsPattern: `${argKeyPrefix("command")}(?!(?:${prefixes.join("|")})(?:[\\s"]|$))`,
        denyMessage: `FF-pane 拒绝：本次 Run 只允许任务合同的验证命令（${verifyCommands.join("、")}）。`,
        note: `shell 策略 verify_only：仅放行验证命令（${verifyCommands.join("、")}）`,
      });
    }
  }

  // 4. 网络（§7 第 4 项）：禁网则联网类工具整体禁用。
  if (!input.envelope.network) {
    rules.push({
      id: "network-forbidden",
      toolName: [...GEMINI_NETWORK_TOOL_NAMES],
      decision: "deny",
      priority,
      denyMessage: "FF-pane 拒绝：本次 Run 的权限信封禁止网络访问。",
      note: "网络禁止：联网类工具整体禁用",
    });
  }

  return rules;
}

/**
 * TOML 字符串字面量。优先单引号 literal string（正则里满是反斜杠，literal string
 * 不做任何转义，最不容易出错）；含单引号或换行时退回 basic string 并转义。
 */
function tomlString(value: string): string {
  if (!value.includes("'") && !/[\n\r]/.test(value)) {
    return `'${value}'`;
  }
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
  return `"${escaped}"`;
}

function tomlToolName(toolName: string | readonly string[]): string {
  if (typeof toolName === "string") {
    return tomlString(toolName);
  }
  return `[${toolName.map((name) => tomlString(name)).join(", ")}]`;
}

/** 渲染选项。 */
export interface GeminiPolicyRenderOptions {
  /** 文件头注释里标注的 Run/任务标识。 */
  readonly label?: string;
}

/** 规则集 → TOML 文本。 */
export function renderGeminiPolicyToml(
  rules: readonly GeminiPolicyRule[],
  options: GeminiPolicyRenderOptions = {},
): string {
  const lines: string[] = [
    "# FF-pane 每 Run 生成的 Gemini CLI 策略文件（经 --policy 下发，用完即删）。",
    "# 请勿手工编辑：内容由 PermissionEnvelope + 设计文档 §7 危险操作清单编译而来。",
    `# 优先级固定 ${GEMINI_POLICY_OVERRIDE_PRIORITY}：--policy 指定的临时目录文件落 DEFAULT 层（base 1），`,
    `# 必须压过内置 yolo.toml 的 allow-all（priority ${GEMINI_YOLO_ALLOW_ALL_PRIORITY}）。`,
    "# 全部为 deny 规则：放行由 --approval-mode 承担，故规则间无优先级歧义。",
  ];
  if (options.label !== undefined) {
    lines.push(`# 标识：${options.label}`);
  }

  for (const rule of rules) {
    lines.push("", `# [${rule.id}] ${rule.note}`);
    lines.push("[[rule]]");
    lines.push(`toolName = ${tomlToolName(rule.toolName)}`);
    if (rule.argsPattern !== undefined) {
      lines.push(`argsPattern = ${tomlString(rule.argsPattern)}`);
    }
    lines.push(`decision = ${tomlString(rule.decision)}`);
    lines.push(`priority = ${rule.priority}`);
    if (rule.denyMessage !== undefined) {
      lines.push(`denyMessage = ${tomlString(rule.denyMessage)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** 信封 → TOML 文本（buildGeminiPolicyRules + renderGeminiPolicyToml 的组合）。 */
export function buildGeminiPolicyToml(input: GeminiPolicyInput): string {
  return renderGeminiPolicyToml(buildGeminiPolicyRules(input), {
    ...(input.label === undefined ? {} : { label: input.label }),
  });
}

/**
 * 复刻 Gemini CLI 的 `stableStringify(args)`（源码 0.57.0）：键按字典序，
 * **顶层键值对各被 NUL 包裹**。仅用于本包单测校验 argsPattern 是否真能命中，
 * 以及排障时手工比对，不参与运行期逻辑。
 */
export function stringifyGeminiToolArgs(args: Readonly<Record<string, unknown>>): string {
  const pairs = Object.keys(args)
    .sort()
    .filter((key) => args[key] !== undefined)
    .map((key) => `\u0000${JSON.stringify(key)}:${JSON.stringify(args[key])}\u0000`);
  return `{${pairs.join(",")}}`;
}

/** 一次工具调用（evaluateGeminiPolicyRules 的输入）。 */
export interface GeminiToolCall {
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** 裁决结果。 */
export interface GeminiPolicyVerdict {
  readonly rule: GeminiPolicyRule;
  readonly decision: GeminiPolicyDecision;
}

/**
 * 迷你策略引擎（按 policy-engine.md 的匹配规则实现：toolName 精确匹配或 `*`，
 * argsPattern 对稳定 JSON 串 test，最高优先级胜出）。
 *
 * 存在的唯一理由是让"规则是否真的拦得住"可被单测断言——真机验证需要认证，
 * 而策略是否生效必须在无认证环境下也能回归。返回 undefined = 无规则命中
 * （即交回 CLI 的默认策略与 --approval-mode 处置）。
 */
export function evaluateGeminiPolicyRules(
  rules: readonly GeminiPolicyRule[],
  call: GeminiToolCall,
): GeminiPolicyVerdict | undefined {
  const stringified = stringifyGeminiToolArgs(call.args);
  let best: GeminiPolicyVerdict | undefined;
  for (const rule of rules) {
    const names: readonly string[] =
      typeof rule.toolName === "string" ? [rule.toolName] : rule.toolName;
    if (!names.includes(call.toolName) && !names.includes("*")) {
      continue;
    }
    if (rule.argsPattern !== undefined && !new RegExp(rule.argsPattern).test(stringified)) {
      continue;
    }
    if (best === undefined || rule.priority > best.rule.priority) {
      best = { rule, decision: rule.decision };
    }
  }
  return best;
}
