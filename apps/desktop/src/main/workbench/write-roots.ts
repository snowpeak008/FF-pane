/**
 * AI 窗口能写哪些目录（T11.8，Tony 2026-11-07）。纯函数，启动窗口时用。
 *
 * - Claude：经环境变量交给 PreToolUse hook（`mcp/write-guard.ts`）检查。
 * - Codex：项目目录本来就是 workspace-write 沙盒能写的，这里只补「项目外可写目录」。
 *
 * 能写：项目目录、系统临时目录、Claude 计划模式的 `~/.claude/plans`、Claude 自己记忆的那个目录
 * （记忆搬进项目记忆之前先留着，T11.8b）、Tony 在项目卡片里填的项目外可写目录。
 */

import { join, resolve } from "node:path";

/** 和 `mcp/write-guard.ts` 的同名常量一致。hook 单独打包、整份拷进安装目录，不能和主进程共用模块。 */
export const WRITE_ROOTS_ENV = "FF_PANE_WRITE_ROOTS";

/** Claude 按工作目录存自己记忆的目录：路径里非字母数字的字符都换成 `-`。 */
export function claudeProjectDataDir(home: string, cwd: string): string {
  return join(home, ".claude", "projects", resolve(cwd).replace(/[^A-Za-z0-9]/g, "-"));
}

/** 去掉空的、重复的（不分大小写），都换成绝对路径。 */
export function cleanOutsideDirs(dirs: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    const trimmed = dir.trim().replace(/^["']|["']$/g, "");
    if (trimmed === "") {
      continue;
    }
    const absolute = resolve(trimmed);
    const key = absolute.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(absolute);
    }
  }
  return out;
}

/** Claude 窗口能写的目录。第一个是项目目录（拒绝原因里会写出来）。 */
export function claudeWriteRoots(input: {
  readonly projectRoot: string;
  readonly cwd: string;
  readonly home: string;
  readonly tmp: string;
  readonly outsideDirs: readonly string[];
}): readonly string[] {
  return cleanOutsideDirs([
    input.projectRoot,
    input.tmp,
    join(input.home, ".claude", "plans"),
    join(claudeProjectDataDir(input.home, input.projectRoot), "memory"),
    join(claudeProjectDataDir(input.home, input.cwd), "memory"),
    ...input.outsideDirs,
  ]);
}

/** Codex 的项目外可写目录：交给 workspace-write 沙盒。没有就不传。 */
export function codexWritableRootsOverride(
  outsideDirs: readonly string[],
): Readonly<Record<string, string>> {
  const dirs = cleanOutsideDirs(outsideDirs);
  return dirs.length > 0 ? { "sandbox_workspace_write.writable_roots": JSON.stringify(dirs) } : {};
}
