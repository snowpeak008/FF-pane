import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initI18n } from "./i18n";
import "./styles/theme.css";
import { applyThemeAtBoot, ThemeProvider } from "./theme";

const container = document.getElementById("root");
if (container === null) {
  // renderer 内开发者日志一律英文（check-i18n 扫描约定，UI 文案必须走语言包）
  throw new Error("renderer bootstrap failed: #root container not found");
}

// 冒烟自测模式：主进程以 ?smoke=1 加载本页（见 src/main/smoke.ts）
const isSmokeMode = new URLSearchParams(window.location.search).get("smoke") === "1";

// 主题先于 React 挂载同步生效，避免 await initI18n 期间闪一帧亮色（见 theme/dom.ts）
applyThemeAtBoot();

// i18n 初始化依赖 IPC（系统语言检测），完成后再挂载 React；
// 即使初始化异常也照常挂载（t() 将显示语言 key，而不是白屏）。
void initI18n()
  .catch((thrown: unknown) => {
    console.error("[renderer] i18n initialization failed:", thrown);
  })
  .then(() => {
    if (isSmokeMode) {
      // 冒烟模式只跑自检，不挂载全功能 App。主进程在 --smoke 下只装配
      // app / diagnostics / smoke 三组通道，而 App 的默认路由是项目页——一挂上就发起它的
      // 页面级查询，于是每次冒烟都在 stderr 上留一行 `No handler registered for '<channel>'`
      // （历史上是 projects:list，T7.4 起是 projects:summary）。给冒烟逐个补空 handler 是
      // 打地鼠：默认页查什么会一直变，而那行噪声与七项判定无关。
      // 「生产 renderer 真的挂得起来」这一层由 E2E 覆盖（每条用例都真实启动应用），
      // 冒烟不重复；它要证的是主进程侧的 SQLite / 密钥 / IPC / 事件 / CSP 五件事。
      return;
    }
    createRoot(container).render(
      <StrictMode>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </StrictMode>,
    );
  });

if (isSmokeMode) {
  void import("./smoke").then(({ runRendererSmoke }) => runRendererSmoke());
}
