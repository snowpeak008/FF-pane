import { defineConfig } from "vitest/config";
import { workspaceSrcAlias } from "./apps/desktop/vitest.workspace-alias.ts";

/**
 * 根级聚合配置：Vitest 4 以 test.projects 取代已移除的 vitest.workspace 文件。
 * 每个匹配目录（含 package.json）自动成为一个测试项目，项目名取包名。
 * apps/desktop 自 T0.2 起纳入（shared-ipc 纯逻辑单测）。
 * scripts 为内联项目（T0.3 起）：仓库级工具脚本（如 check-i18n）的单测。
 */
export default defineConfig({
  resolve: { alias: workspaceSrcAlias },
  test: {
    alias: workspaceSrcAlias,
    // T11.12：单测的临时文件放专用目录，跑完删掉（见 vitest.temp-setup.ts）
    globalSetup: ["./vitest.temp-setup.ts"],
    projects: [
      "packages/*",
      "apps/*",
      {
        test: {
          name: "scripts",
          include: ["scripts/**/*.test.mjs"],
          environment: "node",
        },
      },
    ],
  },
});
