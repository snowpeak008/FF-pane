/**
 * 技能的纯函数部分（T11.9 / 技能计划 §3、§4）：读 SKILL.md 头部、名字规则、猜是哪家写的、
 * 看脚本要什么程序、给 Codex / Grok 拼「本项目启用的技能」那一段、按 CLI 决定挂哪些。
 * 不碰文件系统，全部可单测。
 */

/** 技能适用于哪家。导入时默认 any，用户可在技能库里改。 */
export type SkillAppliesTo = "any" | "claude" | "codex";

export const SKILL_APPLIES_TO_VALUES: readonly SkillAppliesTo[] = ["any", "claude", "codex"];

export function isSkillAppliesTo(value: unknown): value is SkillAppliesTo {
  return value === "any" || value === "claude" || value === "codex";
}

/** 从文件结构猜出来的作者。只当提示，不决定挂不挂。 */
export type SkillAuthorGuess = "codex" | "claude" | "unknown";

/** 窗口用的是哪家 CLI。DeepSeek 窗口走 Claude Code，算 claude-code。 */
export type SkillRuntime = "claude-code" | "codex" | "grok";

/** Claude 和 Codex 都要求：小写字母、数字、连字符，最长 64。 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SKILL_NAME_LENGTH = 64;

export function isValidSkillName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_SKILL_NAME_LENGTH && SKILL_NAME_PATTERN.test(name);
}

export type SkillFrontmatter =
  | {
      readonly ok: true;
      readonly name: string;
      readonly description: string;
      readonly keys: readonly string[];
    }
  | { readonly ok: false; readonly reason: "no-frontmatter" | "no-name" | "no-description" };

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 读 SKILL.md 开头 `---` 之间的头部。只认顶层 `key: value`，
 * 支持引号和 `>` / `|` 折行写法；嵌套的键只记名字不取值。
 */
export function parseSkillFrontmatter(text: string): SkillFrontmatter {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { ok: false, reason: "no-frontmatter" };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) {
    return { ok: false, reason: "no-frontmatter" };
  }
  const values = new Map<string, string>();
  const keys: string[] = [];
  for (let index = 1; index < end; index += 1) {
    const line = lines[index] ?? "";
    const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const key = match[1] ?? "";
    const rest = (match[2] ?? "").trim();
    keys.push(key);
    if (rest === ">" || rest === "|" || rest === ">-" || rest === "|-") {
      const block: string[] = [];
      while (index + 1 < end && /^\s+\S/.test(lines[index + 1] ?? "")) {
        index += 1;
        block.push((lines[index] ?? "").trim());
      }
      values.set(key, block.join(rest.startsWith(">") ? " " : "\n"));
      continue;
    }
    values.set(key, unquote(rest));
  }
  const name = values.get("name")?.trim() ?? "";
  if (name === "") {
    return { ok: false, reason: "no-name" };
  }
  const description = values.get("description")?.trim() ?? "";
  if (description === "") {
    return { ok: false, reason: "no-description" };
  }
  return { ok: true, name, description, keys };
}

/** 只有 Claude 的 SKILL.md 才有的头部字段。 */
const CLAUDE_ONLY_KEYS = new Set(["allowed-tools", "disable-model-invocation", "user-invocable"]);

/**
 * 猜是哪家写的（技能计划 §3.3）。`agents/openai.yaml` → Codex；`.claude-plugin/` 或 Claude 专有字段 → Claude。
 * relPaths 用 `/` 分隔、相对技能目录。
 */
export function guessSkillAuthor(
  relPaths: readonly string[],
  frontmatterKeys: readonly string[],
): SkillAuthorGuess {
  const lower = relPaths.map((path) => path.toLowerCase());
  if (lower.includes("agents/openai.yaml")) {
    return "codex";
  }
  if (
    lower.some((path) => path.startsWith(".claude-plugin/")) ||
    frontmatterKeys.some((key) => CLAUDE_ONLY_KEYS.has(key))
  ) {
    return "claude";
  }
  return "unknown";
}

export interface SkillNeeds {
  /** scripts 里有 .py。 */
  readonly python: boolean;
  /** scripts 里有 .js / .mjs / .cjs。 */
  readonly node: boolean;
  /**
   * 脚本里用 curl.exe 或 PowerShell 访问 https://。Codex 沙盒里这条会失败（技能计划 §2.3），
   * 只提示，不拦。
   */
  readonly windowsHttps: boolean;
}

/** 看脚本要什么程序。files 是相对路径和（小文本文件的）内容。 */
export function detectSkillNeeds(
  files: readonly { readonly rel: string; readonly text?: string }[],
): SkillNeeds {
  let python = false;
  let node = false;
  let windowsHttps = false;
  for (const file of files) {
    const rel = file.rel.toLowerCase();
    if (rel.endsWith(".py")) {
      python = true;
    }
    if (rel.endsWith(".js") || rel.endsWith(".mjs") || rel.endsWith(".cjs")) {
      node = true;
    }
    const text = file.text;
    if (
      text !== undefined &&
      /https:\/\//i.test(text) &&
      /\b(?:curl(?:\.exe)?|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i.test(text)
    ) {
      windowsHttps = true;
    }
  }
  return { python, node, windowsHttps };
}

/** 库里一个技能里，挂载时要用到的部分。 */
export interface SkillMountCandidate {
  readonly name: string;
  readonly description: string;
  readonly appliesTo: SkillAppliesTo;
  /** 库里这份技能的目录（绝对路径）。 */
  readonly dir: string;
  /** SKILL.md 的绝对路径。 */
  readonly skillFile: string;
  /** 当前无法激活的原因；undefined 表示可用。 */
  readonly unavailable?: SkillUnavailableReason;
}

export type SkillUnavailableReason = "invalid" | "python-missing" | "node-missing";

export type SkillSkipReason =
  | "not-in-library"
  | "claude-only"
  | "codex-only"
  | SkillUnavailableReason;

export interface SkillMountPlan {
  readonly mount: readonly SkillMountCandidate[];
  readonly skipped: readonly { readonly name: string; readonly reason: SkillSkipReason }[];
}

/** 按项目勾的技能、窗口用的 CLI，决定挂哪些、跳过哪些（技能计划 §4.2）。 */
export function planSkillMounts(
  enabled: readonly string[],
  library: readonly SkillMountCandidate[],
  runtime: SkillRuntime,
): SkillMountPlan {
  const byName = new Map(library.map((skill) => [skill.name, skill]));
  const mount: SkillMountCandidate[] = [];
  const skipped: { name: string; reason: SkillSkipReason }[] = [];
  for (const name of [...new Set(enabled)]) {
    const skill = byName.get(name);
    if (skill === undefined) {
      skipped.push({ name, reason: "not-in-library" });
      continue;
    }
    if (skill.unavailable !== undefined) {
      skipped.push({ name, reason: skill.unavailable });
      continue;
    }
    if (skill.appliesTo === "claude" && runtime !== "claude-code") {
      skipped.push({ name, reason: "claude-only" });
      continue;
    }
    if (skill.appliesTo === "codex" && runtime !== "codex") {
      skipped.push({ name, reason: "codex-only" });
      continue;
    }
    mount.push(skill);
  }
  return { mount, skipped };
}

/** 单个技能描述在说明里最多占这么多字，整段最多这么多字（Codex 走命令行，要留余量）。 */
export const MAX_SKILL_DESCRIPTION_CHARS = 400;
export const MAX_SKILL_INSTRUCTIONS_CHARS = 4 * 1024;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Codex / Grok 没有按会话挂技能的办法，就把「名字、什么时候用、SKILL.md 在哪」写进窗口说明，
 * 和 CLI 自己列技能的做法一样，AI 用到时自己去读（技能计划 §4.2）。没有要挂的返回 undefined。
 */
export function composeSkillInstructions(
  skills: readonly Pick<SkillMountCandidate, "name" | "description" | "skillFile">[],
): string | undefined {
  if (skills.length === 0) {
    return undefined;
  }
  const header = [
    "## 本项目启用的技能",
    "下面每一项是一个技能：名字、什么时候用、SKILL.md 的位置。任务和某个技能的说明对得上时，先把它的 SKILL.md 从头读完再动手；SKILL.md 里的相对路径都相对它所在的目录。技能目录里的配置文件由用户自己填，不要打开、不要改、不要把里面的内容说出来。",
  ].join("\n");
  const lines: string[] = [];
  let used = header.length;
  for (const skill of skills) {
    const line = `- ${skill.name}：${clip(skill.description, MAX_SKILL_DESCRIPTION_CHARS)}（SKILL.md：${skill.skillFile}）`;
    if (used + line.length + 1 > MAX_SKILL_INSTRUCTIONS_CHARS) {
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return `${header}\n${lines.join("\n")}`;
}
