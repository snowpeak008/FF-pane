import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    // dependencies（better-sqlite3 等原生/运行时依赖）不打进 bundle，保持外部 require
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          // 主进程入口（electron-vite 的缺省入口，显式列出后不再自动推断）
          index: resolve(__dirname, "src/main/index.ts"),
          // T6.6 知识库检索 MCP sidecar：与主进程同为 Node 侧产物，故一并由 main 段构建，
          // 但它**不由主进程 require**，而是由 CLI Agent 作为独立进程拉起
          // （启动方式见 main/session/knowledge-tool.ts）。
          "knowledge-mcp": resolve(__dirname, "src/mcp/server.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // sandbox: true 要求 preload 为 CJS 单文件（Electron 的 ESM preload 必须关沙箱），
        // 输出 .cjs 以免被 package.json 的 "type": "module" 判定为 ESM
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    // tailwindcss()：Tailwind v4 走 vite 插件，无 postcss/tailwind.config 文件；
    // 主题 token 与扫描范围均在 src/renderer/src/styles/theme.css 内声明（W3.1a）
    plugins: [react(), tailwindcss()],
  },
});
