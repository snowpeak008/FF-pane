/**
 * 工作台窗口级临时 MCP 配置文件（T10.4）。
 * 按窗口落在应用临时目录；窗口退出 / kill / 应用退出时清理。永不写入用户 ~/.claude。
 */

import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeMcpConfig,
  CLAUDE_MCP_FILE_NAME,
  type McpStdioServerSpec,
} from "@ff-pane/adapters";

/** 可识别前缀；完整目录名另含随机 hex，避免固定短名可枚举。 */
export const WORKBENCH_MCP_DIR_PREFIX = "ff-pane-wb-mcp-";

/** 启动清扫：超过此时长的陈旧临时目录可删（默认 1 小时）。 */
export const WORKBENCH_MCP_STALE_MS = 60 * 60 * 1000;

export interface WorkbenchMcpTempFile {
  readonly path: string;
  readonly directory: string;
  remove(): Promise<void>;
}

function randomDirPrefix(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `${WORKBENCH_MCP_DIR_PREFIX}${hex}-`;
}

/** 写入 Claude `--mcp-config` 临时文件（内容与 headless 适配器同形）。 */
export function writeWorkbenchClaudeMcpFile(
  servers: Readonly<Record<string, McpStdioServerSpec>>,
  options: { readonly dir?: string } = {},
): WorkbenchMcpTempFile {
  const directory = mkdtempSync(join(options.dir ?? tmpdir(), randomDirPrefix()));
  const path = join(directory, CLAUDE_MCP_FILE_NAME);
  writeFileSync(path, buildClaudeMcpConfig(servers), "utf8");
  let removed = false;
  return {
    path,
    directory,
    remove: async () => {
      if (removed) {
        return;
      }
      removed = true;
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/**
 * 清扫 os.tmpdir() 下陈旧的 `ff-pane-wb-mcp-*` 目录（仅此前缀）。
 * 崩溃残留用；正在使用的目录 mtime 新，不会被误删。
 */
export async function cleanupStaleWorkbenchMcpDirs(
  options: { readonly rootDir?: string; readonly olderThanMs?: number; readonly now?: number } = {},
): Promise<number> {
  const root = options.rootDir ?? tmpdir();
  const olderThan = options.olderThanMs ?? WORKBENCH_MCP_STALE_MS;
  const now = options.now ?? Date.now();
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.startsWith(WORKBENCH_MCP_DIR_PREFIX)) {
      continue;
    }
    const full = join(root, name);
    try {
      const st = statSync(full);
      if (!st.isDirectory()) {
        continue;
      }
      if (now - st.mtimeMs < olderThan) {
        continue;
      }
      await rm(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      // ignore
    }
  }
  return removed;
}

/** 按 windowId 跟踪临时 MCP 目录，便于退出时批量清理。 */
export class WorkbenchMcpTempRegistry {
  private readonly byWindow = new Map<string, WorkbenchMcpTempFile>();

  track(windowId: string, file: WorkbenchMcpTempFile): void {
    const previous = this.byWindow.get(windowId);
    this.byWindow.set(windowId, file);
    if (previous !== undefined && previous.path !== file.path) {
      void previous.remove();
    }
  }

  async release(windowId: string): Promise<void> {
    const file = this.byWindow.get(windowId);
    if (file === undefined) {
      return;
    }
    this.byWindow.delete(windowId);
    await file.remove();
  }

  async releaseAll(): Promise<void> {
    const files = [...this.byWindow.values()];
    this.byWindow.clear();
    await Promise.all(files.map((file) => file.remove()));
  }
}
