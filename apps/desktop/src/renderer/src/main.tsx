import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initI18n } from "./i18n";

const container = document.getElementById("root");
if (container === null) {
  // renderer 内开发者日志一律英文（check-i18n 扫描约定，UI 文案必须走语言包）
  throw new Error("renderer bootstrap failed: #root container not found");
}

// i18n 初始化依赖 IPC（系统语言检测），完成后再挂载 React；
// 即使初始化异常也照常挂载（t() 将显示语言 key，而不是白屏）。
void initI18n()
  .catch((thrown: unknown) => {
    console.error("[renderer] i18n initialization failed:", thrown);
  })
  .then(() => {
    createRoot(container).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });

// 冒烟自测模式：主进程以 ?smoke=1 加载本页（见 src/main/smoke.ts）
if (new URLSearchParams(window.location.search).get("smoke") === "1") {
  void import("./smoke").then(({ runRendererSmoke }) => runRendererSmoke());
}
