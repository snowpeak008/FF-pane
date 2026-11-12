/**
 * 启动时清系统临时目录里本应用的残留（T11.12 加上知识库检索审计目录）。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KNOWLEDGE_AUDIT_DIR_PREFIX } from "../src/main/session/knowledge-tool";
import { cleanupStaleWorkbenchMcpDirs } from "../src/main/workbench/mcp-temp";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeDir(root: string, name: string, ageMs: number, now: number): string {
  const dir = join(root, name);
  mkdirSync(dir);
  const at = (now - ageMs) / 1000;
  utimesSync(dir, at, at);
  return dir;
}

describe("cleanupStaleWorkbenchMcpDirs", () => {
  it("删超过 1 小时的 MCP、钩子、知识库审计目录；新的和别人的不动", async () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-"));
    roots.push(root);
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const stale = [
      makeDir(root, "ff-pane-wb-mcp-aaaa", 2 * hour, now),
      makeDir(root, "ffpane-wb-hooks-bbbb", 2 * hour, now),
      makeDir(root, `${KNOWLEDGE_AUDIT_DIR_PREFIX}cccc`, 2 * hour, now),
    ];
    const kept = [
      makeDir(root, `${KNOWLEDGE_AUDIT_DIR_PREFIX}fresh`, 10 * 60 * 1000, now),
      makeDir(root, "someone-else-dddd", 2 * hour, now),
    ];
    expect(await cleanupStaleWorkbenchMcpDirs({ rootDir: root, now })).toBe(3);
    for (const dir of stale) {
      expect(existsSync(dir)).toBe(false);
    }
    for (const dir of kept) {
      expect(existsSync(dir)).toBe(true);
    }
  });
});
