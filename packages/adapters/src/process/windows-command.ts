/**
 * Windows 可执行文件解析与 .cmd 垫片命令行构造（W2.1a）。
 *
 * 背景：codex / claude / gemini / opencode 真机均以 npm 全局包安装，落地为
 * `%APPDATA%\npm\<name>.cmd` 垫片；Node ≥18.20 出于 CVE-2024-27980 修复禁止
 * 非 shell 模式直接 spawn .cmd/.bat。故本模块自行做 PATH × PATHEXT 解析：
 * 命中 .exe/.com 直接 spawn；其余（.cmd/.bat）经 `cmd.exe /d /s /c` 执行，
 * 参数自行转义 + windowsVerbatimArguments。
 *
 * 转义方案与实测结论（本机 Windows 11 + Node 24 实测，见文件尾注）：
 * - 命令路径：仅一层 `^` 转义元字符，不加引号；
 * - 参数：先按 MSVCRT 规则处理反斜杠与双引号并整体加引号，再 **两层** `^`
 *   转义元字符。cmd 垫片内部会把 `%*` 重新展开并二次解析，只做一层转义时
 *   `&`、`|`、`>`、`%VAR%`、`!` 会在第二层被当成语法，实测直接执行失败。
 *   （cross-spawn 只对 node_modules\.bin 下的垫片开启双层转义；npm 全局垫片
 *   与普通批处理同样需要，本模块对所有 .cmd/.bat 一律双层。）
 *
 * 与 auth-probe/executor.ts 的关系：那边是登录探测专用的一次性执行器，参数
 * 全是固定字面量、转义用的是"删掉引号"的保守做法；本模块要传用户提示词，
 * 必须做完整转义。二者暂不互相 import，auth-probe 的迁移归后续集成工单。
 */

/// <reference types="node" />

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/** cmd.exe 会当成语法的元字符（http://www.robvanderwoude.com/escapechars.php）。 */
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/** 可直接 spawn 的原生可执行扩展名。 */
const NATIVE_EXECUTABLE_EXT = /\.(?:com|exe)$/i;

/** spawn 的实际目标。 */
export interface SpawnTarget {
  /** 传给 child_process.spawn 的 file。 */
  readonly file: string;
  /** 传给 child_process.spawn 的 args（垫片场景已是 /d /s /c + 整串命令行）。 */
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
  /** 解析到的 CLI 可执行文件路径（非 Windows 或未解析时为原始 command）。 */
  readonly resolvedCommand: string;
  /** 是否经 cmd.exe 垫片执行。 */
  readonly viaCmdShim: boolean;
}

function isExecutableFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * 在 PATH × PATHEXT 中查找 Windows 可执行文件，找不到返回 undefined。
 * command 自带路径分隔符时不扫 PATH，只在原地按 PATHEXT 补全。
 */
export function findExecutableOnWindowsPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const rawPathExt = env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD";
  const pathExts = rawPathExt.split(";").filter((ext) => ext !== "");
  const hasOwnExt = path.extname(command) !== "";
  const searchDirs =
    command.includes("\\") || command.includes("/")
      ? [""]
      : (env["PATH"] ?? "").split(path.delimiter);

  for (const rawDir of searchDirs) {
    const dir = rawDir.replace(/^"|"$/g, "");
    const base = dir === "" ? command : path.join(dir, command);
    // 自带扩展名时先试原样，再试补全（"python3.11" 这类会被 extname 误判为有扩展名）。
    const candidates = hasOwnExt
      ? [base, ...pathExts.map((ext) => base + ext)]
      : pathExts.map((ext) => base + ext);
    for (const candidate of candidates) {
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** 命令路径的一层元字符转义（不加引号，cmd 首次解析后即为原文）。 */
function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META_CHARS, "^$1");
}

/** 参数转义：MSVCRT 引号规则 + 双层元字符转义（见文件头说明）。 */
function escapeCmdArgument(argument: string): string {
  // 反斜杠序列 + 双引号：反斜杠翻倍并转义该双引号。
  let escaped = argument.replace(/(\\*)"/g, '$1$1\\"');
  // 结尾反斜杠序列（其后会被我们补上的双引号紧跟）：翻倍。
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META_CHARS, "^$1");
  return escaped.replace(CMD_META_CHARS, "^$1");
}

/**
 * 构造 `cmd.exe /d /s /c` 用的整串命令行（含最外层引号——/s 会剥掉首尾一对
 * 引号，缺了它带空格的路径必然解析失败）。
 */
export function buildCmdShimCommandLine(file: string, args: readonly string[]): string {
  const parts = [escapeCmdCommand(file), ...args.map((arg) => escapeCmdArgument(arg))];
  return `"${parts.join(" ")}"`;
}

/**
 * 解析实际 spawn 目标。
 * 返回 undefined 表示 Windows 下 PATH × PATHEXT 未命中（归一为 spawn-failed /
 * ENOENT，不抛异常）。非 Windows 平台不预解析，交给 spawn 自己报 ENOENT。
 */
export function resolveSpawnTarget(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): SpawnTarget | undefined {
  if (process.platform !== "win32") {
    return {
      file: command,
      args,
      windowsVerbatimArguments: false,
      resolvedCommand: command,
      viaCmdShim: false,
    };
  }

  const found = findExecutableOnWindowsPath(command, env);
  if (found === undefined) {
    return undefined;
  }

  if (NATIVE_EXECUTABLE_EXT.test(found)) {
    return {
      file: found,
      args,
      windowsVerbatimArguments: false,
      resolvedCommand: found,
      viaCmdShim: false,
    };
  }

  return {
    file: env["ComSpec"] ?? "cmd.exe",
    args: ["/d", "/s", "/c", buildCmdShimCommandLine(found, args)],
    windowsVerbatimArguments: true,
    resolvedCommand: found,
    viaCmdShim: true,
  };
}
