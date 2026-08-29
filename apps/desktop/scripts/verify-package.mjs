/**
 * T0.5 产物验证：以 --smoke 启动 electron-builder 产出的 win-unpacked/FF-pane.exe，
 * 复用 T0.2 的自动化冒烟（IPC ping-pong、事件订阅、better-sqlite3、CSP），断言退出码 0。
 *
 * 用法：node apps/desktop/scripts/verify-package.mjs
 * 前置：pnpm --dir apps/desktop run package 已产出 release/win-unpacked/
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 外层兜底超时：冒烟模式自身有 30s 超时（src/main/smoke.ts），此处给足冷启动余量
const TIMEOUT_MS = 120_000;

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exePath = join(desktopDir, "release", "win-unpacked", "FF-pane.exe");

if (!existsSync(exePath)) {
  console.error(`[verify-package] 未找到 ${exePath}`);
  console.error("[verify-package] 请先运行：pnpm --dir apps/desktop run package");
  process.exit(1);
}

console.log(`[verify-package] 启动 ${exePath} --smoke`);
const child = spawn(exePath, ["--smoke"], { stdio: ["ignore", "inherit", "inherit"] });

const timer = setTimeout(() => {
  console.error(`[verify-package] ${TIMEOUT_MS}ms 内进程未退出，判定失败并终止进程`);
  child.kill();
  // kill 后 close 事件的退出码不可信，兜底直接以失败退出
  setTimeout(() => process.exit(1), 3_000).unref();
}, TIMEOUT_MS);

child.on("error", (error) => {
  clearTimeout(timer);
  console.error(`[verify-package] 进程启动失败：${error.message}`);
  process.exit(1);
});

child.on("close", (code) => {
  clearTimeout(timer);
  if (code === 0) {
    console.log("[verify-package] PASS —— 打包版冒烟全部通过，退出码 0");
    process.exit(0);
  }
  console.error(`[verify-package] FAIL —— 打包版冒烟退出码 ${code ?? "null（进程被终止）"}`);
  process.exit(1);
});
