import { defineConfig } from "vitest/config";

/**
 * 根级聚合配置：Vitest 4 以 test.projects 取代已移除的 vitest.workspace 文件。
 * 每个匹配目录（含 package.json）自动成为一个测试项目，项目名取包名。
 * apps/desktop 为占位包（T0.2 才有可测行为），暂不纳入。
 */
export default defineConfig({
  test: {
    projects: ["packages/*"],
  },
});
