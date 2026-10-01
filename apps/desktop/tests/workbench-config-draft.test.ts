/**
 * 配置草案：与设置页相同的校验；未确认不落盘；只给管理者且受开关控制。
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_TOOL_DRAFT_CONFIG } from "@ff-pane/shared";
import { createProjectConfigStore, ProjectConfigScopeBlockedError } from "@ff-pane/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  createConfigDraftHub,
  MAX_PENDING_CONFIG_DRAFTS,
} from "../src/main/session/config-draft-hub";
import { createConfigMailbox } from "../src/main/session/config-tool";
import { createWorkbenchAuthRegistry } from "../src/main/workbench/auth-registry";
import { createWorkbenchConfigDraftActions } from "../src/main/workbench/config-draft-apply";
import { validateWorkbenchConfigDraft } from "../src/main/workbench/config-draft-validate";
import {
  isConfigToolAuthorized,
  shouldAttachConfigTool,
} from "../src/main/workbench/config-tool-attach";
import { decideManagerGrantRestore } from "../src/main/workbench/manager-grant";

const LOCAL = { connectionMode: "local_cli" as const };

describe("shouldAttachConfigTool", () => {
  it("只在已能行使管理权、且开关打开时挂上", () => {
    expect(
      shouldAttachConfigTool({ role: "manager", configToolEnabled: true, managerAuthorized: true }),
    ).toBe(true);
    expect(
      shouldAttachConfigTool({
        role: "manager",
        configToolEnabled: true,
        managerAuthorized: false,
      }),
    ).toBe(false);
    expect(
      shouldAttachConfigTool({
        role: "manager",
        configToolEnabled: false,
        managerAuthorized: true,
      }),
    ).toBe(false);
    expect(
      shouldAttachConfigTool({ role: "worker", configToolEnabled: true, managerAuthorized: true }),
    ).toBe(false);
    expect(
      shouldAttachConfigTool({ role: "planner", configToolEnabled: true, managerAuthorized: true }),
    ).toBe(false);
    expect(
      shouldAttachConfigTool({
        role: "reviewer",
        configToolEnabled: true,
        managerAuthorized: true,
      }),
    ).toBe(false);
    expect(
      shouldAttachConfigTool({ role: "none", configToolEnabled: true, managerAuthorized: true }),
    ).toBe(false);
  });

  it("冷读后未恢复、或被清洗锁住的管理者不挂；用户重新授权的顶层管理者仍挂", () => {
    expect(isConfigToolAuthorized("already")).toBe(true);
    expect(isConfigToolAuthorized("user-reauth")).toBe(true);
    expect(isConfigToolAuthorized("inherit")).toBe(true);
    expect(isConfigToolAuthorized("pending")).toBe(false);
    expect(isConfigToolAuthorized("none")).toBe(false);

    const registry = createWorkbenchAuthRegistry();
    const layout = {
      projectId: "proj-1" as never,
      tabs: [{ id: "tab-1", title: "Tab", root: { type: "leaf" as const, windowId: "locked" } }],
      activeTabId: "tab-1",
      maximizedWindowId: null,
      focusedWindowId: "locked",
      windows: {
        locked: {
          id: "locked",
          projectId: "proj-1" as never,
          title: "locked",
          kind: "claude" as const,
          cwd: "D:\\x",
          createdAt: 0,
          permission: "edit" as const,
          openedBy: { windowId: "gone" },
          parentWindowId: "gone",
          role: "manager" as const,
        },
        child: {
          id: "child",
          projectId: "proj-1" as never,
          title: "child",
          kind: "claude" as const,
          cwd: "D:\\x",
          createdAt: 0,
          permission: "edit" as const,
          openedBy: { windowId: "parent" },
          parentWindowId: "parent",
          role: "manager" as const,
        },
        parent: {
          id: "parent",
          projectId: "proj-1" as never,
          title: "parent",
          kind: "claude" as const,
          cwd: "D:\\x",
          createdAt: 0,
          permission: "edit" as const,
          openedBy: "user" as const,
          role: "manager" as const,
        },
      },
    };
    registry.restoreColdLayout(layout);
    const locked = registry.get("locked");
    const child = registry.get("child");
    const parent = registry.get("parent");
    const lockedGrant = decideManagerGrantRestore({
      role: locked?.role,
      openedBy: locked?.openedBy ?? "user",
      ...(locked?.parentWindowId !== undefined ? { parentWindowId: locked.parentWindowId } : {}),
      parentGranted: false,
      alreadyGranted: registry.isManagerGranted("locked"),
      sanitizeLocked: locked?.sanitizeLocked === true,
      userRoleSet: locked?.userRoleSet === true,
    });
    const childGrant = decideManagerGrantRestore({
      role: child?.role,
      openedBy: child?.openedBy ?? "user",
      ...(child?.parentWindowId !== undefined ? { parentWindowId: child.parentWindowId } : {}),
      ...(parent?.role !== undefined ? { parentRole: parent.role } : {}),
      parentGranted: registry.isManagerGranted("parent"),
      alreadyGranted: registry.isManagerGranted("child"),
      sanitizeLocked: child?.sanitizeLocked === true,
    });
    const parentGrant = decideManagerGrantRestore({
      role: parent?.role,
      openedBy: parent?.openedBy ?? "user",
      parentGranted: false,
      alreadyGranted: registry.isManagerGranted("parent"),
      sanitizeLocked: parent?.sanitizeLocked === true,
      userRoleSet: parent?.userRoleSet === true,
    });
    expect(locked?.sanitizeLocked).toBe(true);
    expect(
      shouldAttachConfigTool({
        role: "manager",
        configToolEnabled: true,
        managerAuthorized: isConfigToolAuthorized(lockedGrant),
      }),
    ).toBe(false);
    expect(
      shouldAttachConfigTool({
        role: "manager",
        configToolEnabled: true,
        managerAuthorized: isConfigToolAuthorized(childGrant),
      }),
    ).toBe(false);
    expect(
      shouldAttachConfigTool({
        role: "manager",
        configToolEnabled: true,
        managerAuthorized: isConfigToolAuthorized(parentGrant),
      }),
    ).toBe(true);
  });
});

describe("validateWorkbenchConfigDraft", () => {
  it("默认配置不能限制项目范围", async () => {
    await expect(
      validateWorkbenchConfigDraft({
        draft: { name: "默认", isDefault: true, projectIds: ["p1"] as never, claude: LOCAL },
        getProvider: async () => undefined,
        boundProjects: [],
      }),
    ).rejects.toThrow(/不能限制范围/);
  });

  it("中转来源不存在时拒绝", async () => {
    await expect(
      validateWorkbenchConfigDraft({
        draft: {
          name: "中转",
          isDefault: false,
          codex: { connectionMode: "relay", providerId: "missing" as never },
        },
        getProvider: async () => undefined,
        boundProjects: [],
      }),
    ).rejects.toThrow(/中转来源不存在/);
  });

  it("名单外仍绑定的项目不许收窄", async () => {
    await expect(
      validateWorkbenchConfigDraft({
        draft: {
          name: "收窄",
          isDefault: false,
          projectIds: ["keep"] as never,
          claude: LOCAL,
        },
        configId: "config-1",
        getProvider: async () => undefined,
        boundProjects: [
          { id: "keep", name: "留下" },
          { id: "other", name: "还绑着" },
        ],
      }),
    ).rejects.toBeInstanceOf(ProjectConfigScopeBlockedError);
  });

  it("本机登录、范围开放可以通过", async () => {
    const normalized = await validateWorkbenchConfigDraft({
      draft: { name: "两边本机", isDefault: false, claude: LOCAL, codex: LOCAL },
      getProvider: async () => undefined,
      boundProjects: [],
    });
    expect(normalized.name).toBe("两边本机");
    expect(normalized.claude?.connectionMode).toBe("local_cli");
  });
});

describe("配置草案未确认不落盘", () => {
  let root: string;

  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("确认后出现在 configs.json；取消则文件不变", async () => {
    root = await mkdtemp(join(tmpdir(), "ff-pane-config-save-"));
    const configsFile = join(root, "configs.json");
    const store = createProjectConfigStore(configsFile);
    await store.ensureDefaultConfig();
    const before = await readFile(configsFile, "utf8");
    const actions = createWorkbenchConfigDraftActions({
      providers: {
        getProvider: async () => undefined,
        listProviders: async () => [],
        createProvider: async () => {
          throw new Error("不应创建来源");
        },
        updateProvider: async () => {
          throw new Error("不应更新来源");
        },
      },
      projectConfigs: store,
      storeSecret: async () => {
        throw new Error("配置草案不应写密钥");
      },
      listBoundProjects: async () => [],
    });
    const mailbox = await createConfigMailbox(root);
    let applies = 0;
    let presented = 0;
    const hub = createConfigDraftHub({
      turnId: "win-manager",
      requestsDir: mailbox.requestsDir,
      responsesDir: mailbox.responsesDir,
      auditPath: mailbox.auditPath,
      publish: (event) => {
        if (event.kind === "config-draft") {
          presented += 1;
        }
      },
      prepare: actions.prepare,
      apply: async (parsed, apiKey) => {
        applies += 1;
        return actions.apply(parsed, apiKey);
      },
      now: () => Date.now(),
      pollIntervalMs: 20,
    });
    hub.start();
    const draftArgs = {
      name: "夜间配置",
      isDefault: false,
      claude: { connectionMode: "local_cli" },
      codex: { connectionMode: "local_cli" },
    };
    await writeFile(
      join(mailbox.requestsDir, "draft-1.json"),
      JSON.stringify({
        id: "draft-1",
        tool: CONFIG_TOOL_DRAFT_CONFIG,
        args: draftArgs,
        at: Date.now(),
      }),
      "utf8",
    );
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && presented < 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(presented).toBe(1);
    expect(applies).toBe(0);
    expect(await readFile(configsFile, "utf8")).toBe(before);

    const confirmed = await hub.respond({
      turnId: "win-manager",
      draftId: "draft-1",
      decision: "confirm",
    });
    expect(confirmed.ok).toBe(true);
    expect(applies).toBe(1);
    const listed = await store.listConfigs();
    expect(listed.some((item) => item.name === "夜间配置")).toBe(true);
    const saved = await readFile(configsFile, "utf8");

    await writeFile(
      join(mailbox.requestsDir, "draft-2.json"),
      JSON.stringify({
        id: "draft-2",
        tool: CONFIG_TOOL_DRAFT_CONFIG,
        args: { ...draftArgs, name: "不该留下" },
        at: Date.now(),
      }),
      "utf8",
    );
    const waitDraft = Date.now() + 3_000;
    while (Date.now() < waitDraft && presented < 2) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(presented).toBe(2);
    expect(applies).toBe(1);
    const rejected = await hub.respond({
      turnId: "win-manager",
      draftId: "draft-2",
      decision: "reject",
      reason: "取消",
    });
    expect(rejected.ok).toBe(true);
    expect(applies).toBe(1);
    expect(await readFile(configsFile, "utf8")).toBe(saved);
    expect((await store.listConfigs()).some((item) => item.name === "不该留下")).toBe(false);
    await hub.dispose();
  });

  it("超过同时等待上限的草案被拒绝，不会进入确认框", async () => {
    root = await mkdtemp(join(tmpdir(), "ff-pane-config-cap-"));
    const configsFile = join(root, "configs.json");
    const store = createProjectConfigStore(configsFile);
    const actions = createWorkbenchConfigDraftActions({
      providers: {
        getProvider: async () => undefined,
        listProviders: async () => [],
        createProvider: async () => {
          throw new Error("不应创建来源");
        },
        updateProvider: async () => {
          throw new Error("不应更新来源");
        },
      },
      projectConfigs: store,
      storeSecret: async () => {
        throw new Error("不应写密钥");
      },
      listBoundProjects: async () => [],
    });
    const mailbox = await createConfigMailbox(root);
    let presented = 0;
    const hub = createConfigDraftHub({
      turnId: "win-manager",
      requestsDir: mailbox.requestsDir,
      responsesDir: mailbox.responsesDir,
      auditPath: mailbox.auditPath,
      publish: (event) => {
        if (event.kind === "config-draft") {
          presented += 1;
        }
      },
      prepare: actions.prepare,
      apply: async () => {
        throw new Error("超限草案不应落盘");
      },
      now: () => Date.now(),
      pollIntervalMs: 20,
    });
    hub.start();
    const total = MAX_PENDING_CONFIG_DRAFTS + 1;
    for (let index = 0; index < total; index += 1) {
      await writeFile(
        join(mailbox.requestsDir, `cap-${index}.json`),
        JSON.stringify({
          id: `cap-${index}`,
          tool: CONFIG_TOOL_DRAFT_CONFIG,
          args: {
            name: `排队${index}`,
            isDefault: false,
            claude: { connectionMode: "local_cli" },
          },
          at: index,
        }),
        "utf8",
      );
    }
    const wait = Date.now() + 3_000;
    while (Date.now() < wait && presented < MAX_PENDING_CONFIG_DRAFTS) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const responseNames = (await readdir(mailbox.responsesDir)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(responseNames).toHaveLength(1);
    const overflow = await readFile(join(mailbox.responsesDir, responseNames[0] ?? ""), "utf8");
    expect(presented).toBe(MAX_PENDING_CONFIG_DRAFTS);
    expect(overflow).toContain("没有交给用户");
    expect(overflow).toContain("没有保存");
    await expect(readFile(configsFile, "utf8")).rejects.toThrow();
    await hub.dispose();
  });
});
