import { defineConfig } from "vitest/config";
// 复合工程开不了 allowImportingTsExtensions，这里的 .ts 后缀只给 Vitest 的配置加载器用。
// @ts-expect-error TS5097
import { workspaceSrcAlias } from "./vitest.workspace-alias.ts";

/**
 * 仅覆盖 shared-ipc 纯逻辑单测（tests/）。
 * Electron 三层集成路径由 pnpm smoke 冒烟脚本客观验收，不进 vitest。
 */
export default defineConfig({
  resolve: { alias: workspaceSrcAlias },
  test: {
    alias: workspaceSrcAlias,
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
