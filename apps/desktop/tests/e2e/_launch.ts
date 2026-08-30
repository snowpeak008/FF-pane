/**
 * Electron E2E 启动 helper（T4.5）。
 *
 * 隔离原则：每个 spec 独占两个临时目录——
 * - FF_PANE_DATA_ROOT → 全局数据根（projects.json / providers.json 等，见 data.ts）；
 * - --user-data-dir  → Electron userData（window-state / secrets 密文）。
 * 两者都在临时区，冒烟绝不触碰真实用户目录。
 *
 * 语言固定：首窗加载后写入 localStorage 的 UI 语言键并 reload，使 i18n 以 en-US 初始化，
 * 让选择器（按钮英文名）稳定，无需在生产代码里散布 data-testid。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type ElectronApplication, expect, type Page } from "@playwright/test";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** i18n 语言持久化键（与 renderer/src/i18n/index.ts 的 STORAGE_KEY 保持一致）。 */
const UI_LANGUAGE_KEY = "ffpane.ui-language";

export interface LaunchedApp {
  readonly app: ElectronApplication;
  readonly page: Page;
  /** 全局数据根临时目录（= FF_PANE_DATA_ROOT）。 */
  readonly dataRoot: string;
  /** 释放实例并清理两个临时目录。 */
  readonly cleanup: () => Promise<void>;
}

/** 过滤出字符串环境变量（process.env 的值在 TS 下为 string|undefined）。 */
function stringEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 启动构建产物（out/main/index.js，经 package.json main 解析），返回首窗 Page。
 * 调用方负责在 finally 中 await cleanup()。
 */
export async function launchApp(): Promise<LaunchedApp> {
  const dataRoot = mkdtempSync(join(tmpdir(), "ffpane-e2e-data-"));
  const userDataDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-udata-"));

  const env = stringEnv(process.env);
  env["FF_PANE_DATA_ROOT"] = dataRoot;
  // 确保走生产 loadFile 路径而非 dev server（helper 面向构建产物）。
  delete env["ELECTRON_RENDERER_URL"];

  const app = await _electron.launch({
    args: [
      ".",
      `--user-data-dir=${userDataDir}`,
      // CI 容器（Ubuntu）无 SUID sandbox，需显式关闭以启动 Chromium。
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ],
    cwd: desktopDir,
    env,
  });

  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  // 固定 UI 语言为 en-US 后重载，让 i18n 以英文初始化（选择器稳定）。
  await page.evaluate((key) => {
    window.localStorage.setItem(key, "en-US");
  }, UI_LANGUAGE_KEY);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");

  const cleanup = async (): Promise<void> => {
    await app.close();
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  };

  return { app, page, dataRoot, cleanup };
}

/** 经 HashRouter 直接导航到指定路由（如 "/projects"、"/settings"）。 */
export async function gotoRoute(page: Page, route: string): Promise<void> {
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, `#${route}`);
}
