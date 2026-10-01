import { defineConfig } from "vitest/config";
import { workspaceSrcAlias } from "../../apps/desktop/vitest.workspace-alias.ts";

export default defineConfig({
  resolve: { alias: workspaceSrcAlias },
  test: {
    alias: workspaceSrcAlias,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
