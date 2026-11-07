/**
 * 项目外写入限制（T11.8，Tony 2026-11-07）。纯函数，Claude 的 PreToolUse hook 进程用。
 *
 * - 写文件的工具（Write、Edit、MultiEdit、NotebookEdit）：目标不在允许的目录里就拒绝。这一条拦得死。
 * - 命令（Bash、PowerShell）：只认常见写法的目标路径（重定向、mkdir、cp、mv、rm、Set-Content……），
 *   读项目外的东西不拦。脚本里再去写哪里，这里看不出来。
 * - 允许的目录由主进程算好，经环境变量 FF_PANE_WRITE_ROOTS（JSON 数组）交给 hook；没有这个变量就不检查。
 *
 * 路径比较不分大小写，认 `C:\`、`C:/`、Git Bash 的 `/c/`、`~`、`$HOME`、`$env:USERPROFILE`、`%USERPROFILE%`。
 */

import { win32 } from "node:path";

export const WRITE_ROOTS_ENV = "FF_PANE_WRITE_ROOTS";

/** 写到这些地方等于丢掉输出，不算写文件。 */
const SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "nul", "nul:", "$null", "con"]);

export function parseWriteRoots(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
      : [];
  } catch {
    return [];
  }
}

function stripQuotes(value: string): string {
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

const HOME_PREFIXES = [
  /^~(?=$|[\\/])/,
  /^\$HOME(?=$|[\\/])/i,
  /^\$env:USERPROFILE(?=$|[\\/])/i,
  /^%USERPROFILE%(?=$|[\\/])/i,
];

/**
 * 统一成可比较的形式：绝对路径、正斜杠、小写、不带结尾斜杠。
 * 认不出的（含没展开的变量、命令替换）返回 undefined，调用方当作「不知道」放过。
 */
export function normalizeWritePath(
  raw: string,
  cwd: string,
  home: string,
  tmp: string,
): string | undefined {
  let value = stripQuotes(raw);
  if (value === "") {
    return undefined;
  }
  for (const prefix of HOME_PREFIXES) {
    if (prefix.test(value)) {
      value = home + value.replace(prefix, "");
      break;
    }
  }
  if (/^\/tmp(?=$|\/)/i.test(value)) {
    value = tmp + value.slice(4);
  }
  // Git Bash：/c/Users → C:/Users
  const msys = /^\/([a-zA-Z])(?=$|\/)/.exec(value);
  if (msys !== null) {
    value = `${msys[1]}:${value.slice(2) || "/"}`;
  }
  if (/[$`%]/.test(value) || value.includes("*") || value.includes("?")) {
    return undefined;
  }
  const resolved = win32.resolve(stripQuotes(cwd), value);
  return resolved.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

export function isInsideRoots(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => target === root || target.startsWith(`${root}/`));
}

// ---------- 从命令里找写的目标 ----------

/**
 * 去掉 heredoc（`<<'EOF'` … `EOF`）和 PowerShell here-string（`@'` … `'@`）的正文：
 * 正文是写进文件的内容，不是命令，里面的 `>`、`rm` 不能当成写操作。保留开头那一行。
 */
function stripHereDocs(command: string): string {
  return command
    .replace(/(<<-?\s*(['"]?)([A-Za-z_][\w-]*)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, "$1")
    .replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, "''");
}

/** 按引号切词；`;`、`&&`、`||`、`|`、换行当成分段。返回每段的词。 */
function splitCommand(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: '"' | "'" | null = null;
  const pushWord = (): void => {
    if (word !== "") {
      words.push(word);
      word = "";
    }
  };
  const pushSegment = (): void => {
    pushWord();
    if (words.length > 0) {
      segments.push(words);
      words = [];
    }
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] ?? "";
    if (quote !== null) {
      word += ch;
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      word += ch;
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "|" || (ch === "&" && command[i + 1] === "&")) {
      pushSegment();
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
        i += 1;
      }
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      pushWord();
      continue;
    }
    // 重定向符单独成词：a>b、2>>b 都拆开。
    if (ch === ">") {
      const prefix = /^(?:\d|\*)?$/.test(word) ? word : "";
      if (prefix === "") {
        pushWord();
      } else {
        word = "";
      }
      let op = `${prefix}>`;
      if (command[i + 1] === ">") {
        op += ">";
        i += 1;
      }
      if (command[i + 1] === "&") {
        // 2>&1 之类：写到另一个输出，不是文件。
        i += 1;
        while (i + 1 < command.length && /[\d-]/.test(command[i + 1] ?? "")) {
          i += 1;
        }
        continue;
      }
      words.push(op);
      continue;
    }
    word += ch;
  }
  pushSegment();
  return segments;
}

/** 带值的 PowerShell 参数里，值是写目标的。 */
const PS_TARGET_PARAMS = new Set([
  "-path",
  "-literalpath",
  "-destination",
  "-filepath",
  "-destinationpath",
  "-outfile",
]);
/** 带值但值不是路径的参数：跳过它的值。 */
const PS_VALUE_PARAMS = new Set([
  "-itemtype",
  "-type",
  "-value",
  "-encoding",
  "-filter",
  "-include",
  "-exclude",
  "-name",
  "-inputobject",
  "-width",
  "-erroraction",
  "-m",
  "-mode",
]);

/** cmd 的内置命令，`/s`、`/q` 这种是开关不是路径。 */
const CMD_SWITCH_COMMANDS = new Set(["del", "erase", "rd", "rmdir", "md", "copy", "move"]);

type CommandKind = "all-args" | "last-arg" | "first-arg";

const WRITE_COMMANDS: Readonly<Record<string, CommandKind>> = {
  mkdir: "all-args",
  md: "all-args",
  touch: "all-args",
  rm: "all-args",
  rmdir: "all-args",
  rd: "all-args",
  del: "all-args",
  erase: "all-args",
  "new-item": "all-args",
  ni: "all-args",
  "remove-item": "all-args",
  ri: "all-args",
  tee: "all-args",
  "tee-object": "first-arg",
  cp: "last-arg",
  mv: "last-arg",
  copy: "last-arg",
  move: "last-arg",
  "copy-item": "last-arg",
  cpi: "last-arg",
  "move-item": "last-arg",
  mi: "last-arg",
  "set-content": "first-arg",
  sc: "first-arg",
  "add-content": "first-arg",
  ac: "first-arg",
  "out-file": "first-arg",
  "expand-archive": "last-arg",
};

function commandName(word: string): string {
  const base = stripQuotes(word).replaceAll("\\", "/").split("/").pop() ?? "";
  return base.toLowerCase().replace(/\.exe$/, "");
}

/** 一段命令里写的目标（原样，未归一）。cd / Set-Location 返回新的工作目录。 */
function segmentTargets(words: readonly string[]): {
  readonly targets: readonly string[];
  readonly cd?: string;
} {
  const targets: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] ?? "";
    if (/^(?:\d|\*)?>>?$/.test(w)) {
      const next = words[i + 1];
      if (next !== undefined) {
        targets.push(next);
        i += 1;
      }
      continue;
    }
    rest.push(w);
  }
  let start = 0;
  // 跳过前面的 sudo、& 调用符和 VAR=x 赋值。
  while (
    start < rest.length &&
    /^(?:&|sudo|command|builtin|[A-Za-z_][A-Za-z0-9_]*=.*)$/.test(rest[start] ?? "")
  ) {
    start += 1;
  }
  const name = commandName(rest[start] ?? "");
  if (name === "cd" || name === "set-location" || name === "sl" || name === "pushd") {
    const dest = rest.slice(start + 1).find((w) => !w.startsWith("-"));
    return { targets, ...(dest !== undefined ? { cd: dest } : {}) };
  }
  const kind = WRITE_COMMANDS[name];
  if (kind === undefined) {
    return { targets };
  }
  const positional: string[] = [];
  const named: string[] = [];
  const args = rest.slice(start + 1);
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i] ?? "";
    const lower = w.toLowerCase();
    if (PS_TARGET_PARAMS.has(lower)) {
      const next = args[i + 1];
      if (next !== undefined) {
        named.push(next);
        i += 1;
      }
      continue;
    }
    if (PS_VALUE_PARAMS.has(lower)) {
      i += 1;
      continue;
    }
    if (w.startsWith("-") || (CMD_SWITCH_COMMANDS.has(name) && /^\/[A-Za-z?]{1,2}$/.test(w))) {
      continue;
    }
    positional.push(w);
  }
  if (named.length > 0) {
    targets.push(...named);
  } else if (kind === "all-args") {
    targets.push(...positional);
  } else if (kind === "last-arg") {
    const last = positional.at(-1);
    if (last !== undefined && positional.length >= 2) {
      targets.push(last);
    }
  } else {
    const first = positional[0];
    if (first !== undefined) {
      targets.push(first);
    }
  }
  return { targets };
}

/** 命令里写的目标，已按命令里的 cd 换算成绝对路径并归一。认不出的不列。 */
export function shellWriteTargets(
  command: string,
  cwd: string,
  home: string,
  tmp: string,
): readonly { readonly raw: string; readonly path: string }[] {
  const out: { raw: string; path: string }[] = [];
  let dir = cwd;
  for (const words of splitCommand(stripHereDocs(command))) {
    const { targets, cd } = segmentTargets(words);
    for (const raw of targets) {
      if (SINKS.has(stripQuotes(raw).toLowerCase())) {
        continue;
      }
      const path = normalizeWritePath(raw, dir, home, tmp);
      if (path !== undefined) {
        out.push({ raw: stripQuotes(raw), path });
      }
    }
    if (cd !== undefined) {
      const next = normalizeWritePath(cd, dir, home, tmp);
      if (next !== undefined) {
        dir = next;
      }
    }
  }
  return out;
}

// ---------- 裁决 ----------

export interface WriteGuardInput {
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly cwd: string;
}

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

export function denyReason(raw: string, projectRoot: string | undefined): string {
  return `不能写到项目外：${raw}。只能写项目目录${projectRoot !== undefined ? `（${projectRoot}）` : ""}和临时目录里面。确实要写项目外，就停下来，用 ffpane_report 报给上级，由用户在软件里加「项目外可写目录」。`;
}

/** 该拒绝就返回原因，放行返回 undefined。roots 为空表示没配置，一律放行。 */
export function checkWrite(
  input: WriteGuardInput,
  roots: readonly string[],
  home: string,
  tmp: string,
): string | undefined {
  if (roots.length === 0) {
    return undefined;
  }
  const normalizedRoots = roots
    .map((root) => normalizeWritePath(root, root, home, tmp))
    .filter((root): root is string => root !== undefined);
  const projectRoot = roots[0];
  if (FILE_TOOLS.has(input.toolName)) {
    const raw = input.toolInput["file_path"] ?? input.toolInput["notebook_path"];
    if (typeof raw !== "string" || raw.trim() === "") {
      return undefined;
    }
    const path = normalizeWritePath(raw, input.cwd, home, tmp);
    return path !== undefined && !isInsideRoots(path, normalizedRoots)
      ? denyReason(raw, projectRoot)
      : undefined;
  }
  if (SHELL_TOOLS.has(input.toolName)) {
    const command = input.toolInput["command"];
    if (typeof command !== "string") {
      return undefined;
    }
    const outside = shellWriteTargets(command, input.cwd, home, tmp).find(
      (target) => !isInsideRoots(target.path, normalizedRoots),
    );
    return outside !== undefined ? denyReason(outside.raw, projectRoot) : undefined;
  }
  return undefined;
}

/** Claude PreToolUse 的拒绝输出。 */
export function denyHookOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}
