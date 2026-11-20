/**
 * 开可改可跑命令的 Claude 窗口前的两项检查（T11.20）：Claude 版本够不够、本机装没装沙盒。
 * 判断规则在 claude-sandbox.ts（纯函数）；这里只负责去问系统，并缓存结果。
 */

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { type ClaudeSandboxCheck, judgeClaudeSandbox, parseClaudeVersion } from "./claude-sandbox";

const PROBE_TIMEOUT_MS = 15_000;
/** 沙盒账户名（sandbox-runtime 默认）。 */
const SANDBOX_USER = "srt-sandbox";

function run(file: string, args: readonly string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: "utf8" },
      (error, stdout) => {
        resolve({ ok: error === null, stdout: typeof stdout === "string" ? stdout : "" });
      },
    );
  });
}

/** 按可执行文件路径和修改时间缓存版本号：升级 Claude 后文件变了，自动重查。 */
const versionCache = new Map<string, string | undefined>();
/** 装上了就不会自己消失，记一次；没装每次都重查（用户可能刚装完）。 */
let sandboxInstalled = false;

function cacheKey(file: string): string {
  try {
    return `${file}|${statSync(file).mtimeMs}`;
  } catch {
    return file;
  }
}

/** `claude --version`。file / args 是解析好的直启目标（不经 cmd.exe）。认不出返回 undefined。 */
export async function probeClaudeVersion(target: {
  readonly file: string;
  readonly args: readonly string[];
}): Promise<string | undefined> {
  const key = cacheKey(target.file);
  if (versionCache.has(key)) {
    return versionCache.get(key);
  }
  const result = await run(target.file, [...target.args, "--version"]);
  const version = parseClaudeVersion(result.stdout);
  versionCache.set(key, version);
  return version;
}

/** 本机有没有 srt-sandbox 账户（`net user` 查到即算装了）。 */
export async function probeClaudeSandboxInstalled(): Promise<boolean> {
  if (sandboxInstalled || process.platform !== "win32") {
    return true;
  }
  const result = await run("net", ["user", SANDBOX_USER]);
  sandboxInstalled = result.ok;
  return sandboxInstalled;
}

/** 两项一起查。 */
export async function checkClaudeSandbox(target: {
  readonly file: string;
  readonly args: readonly string[];
}): Promise<ClaudeSandboxCheck> {
  const [version, installed] = await Promise.all([
    probeClaudeVersion(target),
    probeClaudeSandboxInstalled(),
  ]);
  return judgeClaudeSandbox({ version, installed });
}

/** 测试用：清掉缓存。 */
export function resetClaudeSandboxProbeCache(): void {
  versionCache.clear();
  sandboxInstalled = false;
}
