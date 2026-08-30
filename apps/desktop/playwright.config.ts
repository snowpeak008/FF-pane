import { defineConfig } from "@playwright/test";

/**
 * Electron E2E 配置（T4.5 / 开发计划 §7 T4.5）。
 *
 * 冒烟经 `_electron.launch` 直接驱动 electron-vite 构建产物（out/main/index.js），
 * 不使用 Playwright 的浏览器 projects——故无需下载浏览器二进制
 * （安装时 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1）。
 *
 * 串行执行（workers:1）：每个 spec 各自 launch 一个 Electron 实例并占用独立
 * 临时数据目录，串行可避免实例/端口/原生模块争用，冒烟量级不需要并行。
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  // Electron 冷启动 + 构建产物加载在 CI（尤其 xvfb 下）偏慢，给足超时
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "retain-on-failure",
  },
});
