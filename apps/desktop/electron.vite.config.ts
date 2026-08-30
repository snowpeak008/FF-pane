import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    // dependencies（better-sqlite3 等原生/运行时依赖）不打进 bundle，保持外部 require
    plugins: [externalizeDepsPlugin()],
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
