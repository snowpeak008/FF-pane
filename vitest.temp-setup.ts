import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * T11.12：单测在系统临时目录里留下的东西（ffpane-digest-*、旧 Aider / Grok 适配器的提示文件等）
 * 一次性兜住：跑测试期间把 TEMP / TMP / TMPDIR 指到一个专用目录，跑完整个删掉。
 * 测试进程由 Vitest 在这之后才拉起，继承这里改过的环境。上次中途被杀留下的，超过一天的顺手删。
 */
const PREFIX = "ffpane-vitest-";
const STALE_MS = 24 * 60 * 60 * 1000;

export default function setup(): () => void {
  const root = tmpdir();
  for (const name of readdirSync(root)) {
    if (!name.startsWith(PREFIX)) {
      continue;
    }
    const full = join(root, name);
    try {
      if (Date.now() - statSync(full).mtimeMs >= STALE_MS) {
        rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // 删不掉的下次再说
    }
  }
  const dir = mkdtempSync(join(root, PREFIX));
  for (const key of ["TEMP", "TMP", "TMPDIR"]) {
    process.env[key] = dir;
  }
  return () => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  };
}
