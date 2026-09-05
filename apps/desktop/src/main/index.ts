import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { registerInvokeHandlers } from "../shared-ipc/server";
import { installCsp } from "./csp";
import { createDataHandlers } from "./data";
import { createKnowledgeHandlers } from "./knowledge";
import { createQuitCoordinator, createSessionLayer } from "./session";
import { startSmokeMode } from "./smoke";
import { runSqliteCheck } from "./sqlite-check";
import { loadWindowState, trackWindowState } from "./window-state";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const isSmokeMode = process.argv.includes("--smoke");
/** electron-vite dev 会注入渲染层 dev server 地址；生产/冒烟模式下为空。 */
const devRendererUrl = process.env["ELECTRON_RENDERER_URL"];

/** 当前主窗口引用（目录选择器等原生弹窗挂靠父窗口时惰性取用）。 */
let mainWindow: BrowserWindow | null = null;

function createMainWindow(options: { readonly hidden: boolean }): BrowserWindow {
  const state = loadWindowState();
  const window = new BrowserWindow({
    title: "FF-pane",
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    show: false,
    webPreferences: {
      preload: join(moduleDir, "../preload/index.cjs"),
      // 安全基线（技术选型 §2 / §3 硬性规则）
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow = window;
  window.on("closed", () => {
    mainWindow = null;
  });

  trackWindowState(window);
  window.on("ready-to-show", () => {
    if (!options.hidden) {
      if (state.maximized) {
        window.maximize();
      }
      window.show();
    }
  });

  // 安全基线：不开新窗口；http(s) 外链交给系统浏览器
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:") || url.startsWith("http:")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  // 安全基线：禁止页面导航离开应用（开发模式放行 dev server 自身）
  window.webContents.on("will-navigate", (event, url) => {
    const allowed = devRendererUrl !== undefined && url.startsWith(devRendererUrl);
    if (!allowed) {
      event.preventDefault();
    }
  });

  if (devRendererUrl !== undefined && !isSmokeMode) {
    void window.loadURL(devRendererUrl);
  } else {
    void window.loadFile(
      join(moduleDir, "../renderer/index.html"),
      isSmokeMode ? { query: { smoke: "1" } } : undefined,
    );
  }
  return window;
}

function registerAppHandlers(): void {
  registerInvokeHandlers(ipcMain, {
    "app:get-info": () => ({
      name: "FF-pane",
      version: app.getVersion(),
      runtime: {
        electron: process.versions["electron"] ?? "unknown",
        chrome: process.versions["chrome"] ?? "unknown",
        node: process.versions.node,
      },
    }),
    // T0.3 i18n：系统语言检测统一由主进程提供（renderer 侧 navigator.language 不可靠）
    "app:get-locale": () => ({ locale: app.getLocale() }),
    "app:ping": (request) => ({
      reply: "pong" as const,
      echoed: request.message,
      repliedAt: Date.now(),
    }),
    "diagnostics:check-sqlite": () => runSqliteCheck(),
  });
}

async function bootstrap(): Promise<void> {
  installCsp(session.defaultSession, devRendererUrl !== undefined);
  registerAppHandlers();

  if (isSmokeMode) {
    startSmokeMode(() => createMainWindow({ hidden: true }));
    return;
  }

  // 正常启动：先做 R1 自检；失败给出明确的日志与弹窗，但不阻止窗口打开
  try {
    const report = runSqliteCheck();
    console.log(`[main] better-sqlite3 自检通过（SQLite ${report.sqliteVersion}）`);
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    console.error(`[main] ${message}`);
    dialog.showErrorBox("FF-pane：SQLite 自检失败", message);
  }

  // 数据层接线：解析全局根、幂等初始化布局、注册 projects / dialog handlers。
  // 失败不阻止窗口打开（页面自身的错误态会呈现 IPC 失败原文）。
  try {
    const dataHandlers = await createDataHandlers(() => mainWindow);
    registerInvokeHandlers(ipcMain, dataHandlers);
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    console.error(`[main] 数据层初始化失败：${message}`);
    dialog.showErrorBox("FF-pane：数据目录初始化失败", message);
  }

  // 会话执行层接线（T4.2）：适配器注册表 + 编排器 + 流式事件推送。
  // 独立 try：装配失败只让会话执行不可用，不牵连数据层与窗口。
  try {
    const sessionLayer = await createSessionLayer(() => mainWindow);
    registerInvokeHandlers(ipcMain, sessionLayer.handlers);

    // 退出钩子（T8.2b；T8.5c 增补 opencode server 关停）：有在飞轮次时先就地收尾
    // （transcript / Run / 任务 / 标记）再退出，总时长上限 QUIT_TOTAL_BUDGET_MS；
    // 常驻 server 在收尾之后、退出之前关停（独立小预算）。子进程由 Job Object 兜底（T8.2）。
    const quitCoordinator = createQuitCoordinator({
      hasInflight: () => sessionLayer.orchestrator.activeCount() > 0,
      prepare: () => sessionLayer.orchestrator.prepareForQuit(),
      hasRuntimeResources: () => sessionLayer.registry.hasRuntimeResources(),
      closeRuntimes: () => sessionLayer.registry.closeRuntimes(),
      quit: () => app.quit(),
      log: (message) => console.log(`[main] ${message}`),
    });
    app.on("before-quit", (event) => quitCoordinator.onBeforeQuit(event));

    // 启动修正（T8.2b）：对已登记项目各扫一遍上次被中断的轮次。后台进行、不挡窗口；
    // 会话层 handlers 首次触碰某项目时还会按项目再保证一次（幂等）。
    void sessionLayer.repairRegisteredProjects();
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    console.error(`[main] session layer init failed: ${message}`);
  }

  // 知识库层接线（T6.5）：索引库连接 + sqlite-vec 装载 + 导入编排。
  // 独立 try：装配失败（索引库损坏等）只让知识库页不可用，不牵连数据层与会话层。
  try {
    const knowledgeHandlers = await createKnowledgeHandlers(() => mainWindow);
    registerInvokeHandlers(ipcMain, knowledgeHandlers);
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    console.error(`[main] knowledge layer init failed: ${message}`);
  }

  createMainWindow({ hidden: false });
}

app
  .whenReady()
  .then(bootstrap)
  .catch((thrown: unknown) => {
    console.error(`[main] 启动失败：${String(thrown)}`);
    app.exit(1);
  });

app.on("window-all-closed", () => {
  // 单窗口应用：所有平台关窗即退出（macOS 常驻托盘习惯留待后续任务决策）
  app.quit();
});
