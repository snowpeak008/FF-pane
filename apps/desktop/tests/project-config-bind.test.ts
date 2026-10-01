/**
 * 改绑定必须走主进程：名单外的 configId 不能写入 project.json。
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(""),
    decryptString: () => "",
  },
  app: { isPackaged: false, getPath: () => tmpdir() },
  BrowserWindow: class {},
}));

const root = mkdtempSync(join(tmpdir(), "ffpane-config-bind-"));

beforeAll(() => {
  process.env["FF_PANE_DATA_ROOT"] = join(root, "data");
});

afterAll(() => {
  delete process.env["FF_PANE_DATA_ROOT"];
  rmSync(root, { recursive: true, force: true });
});

describe("projects:update-settings 配置范围", () => {
  it("拒绝名单外的 configId，范围内可以绑定，清空绑定仍然可以", async () => {
    const { createDataHandlers, ProjectConfigNotVisibleError } = await import("../src/main/data");
    const handlers = await createDataHandlers(() => null);
    const alphaDir = join(root, "alpha");
    const betaDir = join(root, "beta");
    mkdirSync(alphaDir, { recursive: true });
    mkdirSync(betaDir, { recursive: true });
    await handlers["configs:list"](undefined);
    const alpha = await handlers["projects:create"]({ name: "甲", rootPath: alphaDir });
    const beta = await handlers["projects:create"]({ name: "乙", rootPath: betaDir });
    const narrow = await handlers["configs:create"]({
      draft: {
        name: "只给甲",
        isDefault: false,
        projectIds: [alpha.id],
        claude: { connectionMode: "local_cli" },
      },
    });

    await expect(
      handlers["projects:update-settings"]({
        projectRoot: beta.rootPath,
        patch: { configId: narrow.id },
      }),
    ).rejects.toBeInstanceOf(ProjectConfigNotVisibleError);
    expect(
      (await handlers["projects:get-settings"]({ projectRoot: beta.rootPath })).configId,
    ).toBeUndefined();

    await expect(
      handlers["projects:create"]({
        name: "丙",
        rootPath: join(root, "gamma"),
        configId: narrow.id,
      }),
    ).rejects.toBeInstanceOf(ProjectConfigNotVisibleError);

    const bound = await handlers["projects:update-settings"]({
      projectRoot: alpha.rootPath,
      patch: { configId: narrow.id },
    });
    expect(bound.configId).toBe(narrow.id);

    const cleared = await handlers["projects:update-settings"]({
      projectRoot: alpha.rootPath,
      patch: { configId: null },
    });
    expect(cleared.configId).toBeUndefined();
  }, 20_000);
});
