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
          // T9.1 工作台自配置 MCP sidecar：同上进程模型（CLI 拉起、文件信箱与主进程通信）。
          "config-mcp": resolve(__dirname, "src/mcp/config-server.ts"),
          // T10.6' 观察型 hook：普通 node 直接执行的 .mjs，不进 asar。
          "workbench-hook": resolve(__dirname, "src/mcp/workbench-hook.ts"),
          // T10.7a 工作台 MCP sidecar：与知识库 sidecar 相同，由 CLI 以 ELECTRON_RUN_AS_NODE 拉起。
          "workbench-mcp": resolve(__dirname, "src/mcp/workbench-server.ts"),
        },
        output: {
          entryFileNames: (chunk) =>
            chunk.name === "workbench-hook" ? "workbench-hook.mjs" : "[name].js",
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
