import { defineConfig } from "vitest/config";

/**
 * 仅覆盖 shared-ipc 纯逻辑单测（tests/）。
 * Electron 三层集成路径由 pnpm smoke 冒烟脚本客观验收，不进 vitest。
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
