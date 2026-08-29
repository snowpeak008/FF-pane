import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("renderer 启动失败：找不到 #root 容器");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 冒烟自测模式：主进程以 ?smoke=1 加载本页（见 src/main/smoke.ts）
if (new URLSearchParams(window.location.search).get("smoke") === "1") {
  void import("./smoke").then(({ runRendererSmoke }) => runRendererSmoke());
}
