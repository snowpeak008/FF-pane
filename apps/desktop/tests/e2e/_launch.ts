/**
 * Electron E2E 启动 helper（T4.5）。
 *
 * 隔离原则：每个 spec 独占临时目录——
 * - FF_PANE_DATA_ROOT → 全局数据根（projects.json / providers.json 等，见 data.ts）；
 * - --user-data-dir  → Electron userData（window-state / secrets 密文）；
 * - CODEX_HOME / CLAUDE_CONFIG_DIR / GROK_HOME → 避免扫/写用户真实 ~/.codex、~/.claude、~/.grok。
 * 全部落在临时区，冒烟绝不触碰真实用户 CLI 配置目录。
 *
 * 语言固定：首窗加载后写入 localStorage 的 UI 语言键并 reload，使 i18n 以 en-US 初始化，
 * 让选择器（按钮英文名）稳定，无需在生产代码里散布 data-testid。
 *
 * 系统语言固定（可选 `lang`）：Electron 的 `--lang=<tag>` 开关会覆盖 `app.getLocale()`
 * （本机实测：系统 zh-CN 下 `--lang=en-US` → `app.getLocale() === "en-US"`），从而固定
 * `app:get-locale` 的返回。要断言「选跟随系统后界面当场变成系统语言」这类与跑测机器
 * 语言相关的结论时用它，否则断言只能弱化为「是一种受支持语言」。
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type ElectronApplication, expect, type Page } from "@playwright/test";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** i18n 语言持久化键（与 renderer/src/i18n/index.ts 的 STORAGE_KEY 保持一致）。 */
const UI_LANGUAGE_KEY = "ffpane.ui-language";

/**
 * cleanup 里 app.close() 的等待预算（T9.8 顺手项）。正常收尾含 prepareForQuit
 * （3 s 总预算）+ runtime 关停（1 s）+ Electron 进程退出，负载下实测量级 ≤ 10 s；
 * 30 s ≈ 3 倍裕量。超时即判定挂死，走强杀兜底（见 cleanup 注释）。
 */
const CLEANUP_CLOSE_BUDGET_MS = 30_000;

export interface LaunchedApp {
  readonly app: ElectronApplication;
  readonly page: Page;
  /** 全局数据根临时目录（= FF_PANE_DATA_ROOT）。 */
  readonly dataRoot: string;
  /** Codex 会话根临时目录（= CODEX_HOME）；可预置假 sessions。 */
  readonly codexHome: string;
  /** Claude 配置临时目录（= CLAUDE_CONFIG_DIR）。 */
  readonly claudeConfigDir: string;
  /** Grok 配置临时目录（= GROK_HOME）。 */
  readonly grokHome: string;
  /** 释放实例并清理临时目录。 */
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

export interface LaunchOptions {
  /** 固定 Electron 报告的系统语言（BCP 47，如 "zh-CN"），经 `--lang` 开关覆盖 `app.getLocale()`。 */
  readonly lang?: string;
  /**
   * 前置到 PATH 的目录（T8.3b）：放假 Agent CLI（如挂起不结束的 codex 替身），
   * 让「派发后轮次在飞」在不联网、无真机 CLI 的前提下可被 E2E 观察。
   * Windows 下环境变量键可能是 Path / path，按大小写不敏感语义就地改写。
   */
  readonly pathPrepend?: string;
  /** 复用已有全局数据根（T10.2 重启恢复布局）；缺省则新建临时目录。 */
  readonly dataRoot?: string;
  /** cleanup 时是否删除 dataRoot（复用场景传 false）。 */
  readonly retainDataRoot?: boolean;
  /**
   * 复用已有 CODEX_HOME（认领 E2E 可先预置 sessions 再启动）；
   * 缺省则新建空临时目录。
   */
  readonly codexHome?: string;
}

/**
 * 启动构建产物（out/main/index.js，经 package.json main 解析），返回首窗 Page。
 * 调用方负责在 finally 中 await cleanup()。
 */
export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const dataRoot = options.dataRoot ?? mkdtempSync(join(tmpdir(), "ffpane-e2e-data-"));
  const userDataDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-udata-"));
  const codexHome = options.codexHome ?? mkdtempSync(join(tmpdir(), "ffpane-e2e-codex-"));
  const claudeConfigDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-claude-"));
  const grokHome = mkdtempSync(join(tmpdir(), "ffpane-e2e-grok-"));
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  const retainDataRoot = options.retainDataRoot === true;
  const retainCodexHome = options.codexHome !== undefined;

  const env = stringEnv(process.env);
  env["FF_PANE_DATA_ROOT"] = dataRoot;
  env["FF_PANE_E2E"] = "1";
  env["CODEX_HOME"] = codexHome;
  env["CLAUDE_CONFIG_DIR"] = claudeConfigDir;
  env["GROK_HOME"] = grokHome;
  // 确保走生产 loadFile 路径而非 dev server（helper 面向构建产物）。
  delete env["ELECTRON_RENDERER_URL"];
  if (options.pathPrepend !== undefined) {
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    const existing = env[pathKey];
    env[pathKey] =
      existing === undefined
        ? options.pathPrepend
        : `${options.pathPrepend}${delimiter}${existing}`;
  }

  const app = await _electron.launch({
    args: [
      ".",
      `--user-data-dir=${userDataDir}`,
      ...(options.lang !== undefined ? [`--lang=${options.lang}`] : []),
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
    // 有界关闭 + 强杀兜底（T9.8 顺手项，config-tool flake 第二轮处置）：
    // T9.6 的 120 s afterAll 预算加固后仍复发（第七见），且本套 E2E 本就 workers:1
    // 全串行——失败形态是 app.close() 真挂住（正常收尾 3~5 s，120 s 都等不到），
    // 而非负载性变慢。已知成因形态：spec 的挂起假 CLI（ping 86400）树杀在负载下
    // 失手时，孤儿子进程持有 Electron 的 stdio 管道，Playwright 等不到进程 close
    // 事件。兜底：预算内等优雅关闭（3 倍裕量），超时强杀 Electron 进程——其
    // 后代由 Job Object（KILL_ON_JOB_CLOSE）+ libuv 全局 Job 在进程消亡时收走
    // （T8.2 关应用即清场语义），临时目录照常清理。只动测试基建，不动生产参数。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      app.close().then(() => "closed" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), CLEANUP_CLOSE_BUDGET_MS);
      }),
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (outcome === "timeout") {
      console.warn(
        `[e2e] app.close() exceeded ${CLEANUP_CLOSE_BUDGET_MS} ms; force-killing electron process`,
      );
      app.process().kill();
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    } else {
      // 优雅关闭后仍给内核一点时间释放目录句柄（Windows EPERM）
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!retainDataRoot) {
      try {
        rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
      } catch (error) {
        console.warn(`[e2e] cleanup dataRoot skipped: ${String(error)}`);
      }
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    } catch (error) {
      console.warn(`[e2e] cleanup userDataDir skipped: ${String(error)}`);
    }
    if (!retainCodexHome) {
      try {
        rmSync(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
      } catch (error) {
        console.warn(`[e2e] cleanup codexHome skipped: ${String(error)}`);
      }
    }
    try {
      rmSync(claudeConfigDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    } catch (error) {
      console.warn(`[e2e] cleanup claudeConfigDir skipped: ${String(error)}`);
    }
    try {
      rmSync(grokHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    } catch (error) {
      console.warn(`[e2e] cleanup grokHome skipped: ${String(error)}`);
    }
  };

  return { app, page, dataRoot, codexHome, claudeConfigDir, grokHome, cleanup };
}

/** 经 HashRouter 直接导航到指定路由（如 "/projects"、"/settings"）。 */
export async function gotoRoute(page: Page, route: string): Promise<void> {
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, `#${route}`);
}
