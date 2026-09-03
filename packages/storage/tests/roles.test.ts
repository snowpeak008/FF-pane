/**
 * T8.4 storage 侧单测：自定义角色 CRUD 与 roles.json 持久化，全部走 mkdtemp
 * 临时目录真实读写。覆盖：CRUD round-trip（中文 name、时间戳维护）、首次使用空集、
 * id 规则（role- 前缀）、注入校验回调（拒绝时不落盘、抛错原样上行）、
 * 删除保护（profileReferencesRole + RoleInUseError）、
 * W1.2a 损坏隔离与结构不符的错误语义、读入边界 id 前缀复核。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentProfile,
  CustomRoleId,
  PermissionEnvelope,
  ProfileId,
  ProviderId,
} from "@ff-pane/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CustomRoleDraft,
  createRoleStore,
  profileReferencesRole,
  ROLES_FILE_VERSION,
  RoleInUseError,
  RoleNotFoundError,
  type RoleStore,
  RolesFileInvalidError,
  resolveGlobalLayout,
  StorageCorruptJsonError,
  writeJsonAtomic,
  writeTextAtomic,
} from "../src/index.js";

let tempRoot: string;
let rolesFile: string;
let store: RoleStore;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ff-pane-roles-"));
  // 走 W1.2a 布局的规范路径，验证与 resolveGlobalLayout 的接线方式
  rolesFile = resolveGlobalLayout(join(tempRoot, ".aiworkbench")).rolesFile;
  store = createRoleStore(rolesFile);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const DOC_PRESET: PermissionEnvelope = {
  readPaths: ["**"],
  writePaths: ["docs/**"],
  shell: "forbidden",
  network: false,
  dangerousOpsRequireApproval: true,
};

function docDraft(overrides: Partial<CustomRoleDraft> = {}): CustomRoleDraft {
  return {
    name: "文档撰写者",
    systemPrompt: "你是文档撰写者。只改 docs/ 下的文档。",
    permissionPreset: DOC_PRESET,
    ...overrides,
  };
}

describe("首次使用与文件持久化", () => {
  it("文件不存在视为空集：list 返回 []、get 返回 undefined，不抛错", async () => {
    expect(await store.listRoles()).toEqual([]);
    expect(await store.getRole("role-000000000000" as CustomRoleId)).toBeUndefined();
  });

  it("首个 create 自动建档：落盘为 version 字段 + 条目数组，id 带 role- 前缀，时间戳成对", async () => {
    const created = await store.createRole(docDraft());
    expect(created.id.startsWith("role-")).toBe(true);
    expect(created.createdAt).toBe(created.updatedAt);
    const raw = JSON.parse(await readFile(rolesFile, "utf8")) as {
      version: number;
      roles: unknown[];
    };
    expect(raw.version).toBe(ROLES_FILE_VERSION);
    expect(raw.roles).toHaveLength(1);
    expect(raw.roles[0]).toEqual(created);
  });

  it("JSON 语法损坏：沿用 W1.2a 隔离语义并向上传递 StorageCorruptJsonError，之后回到空集", async () => {
    await writeTextAtomic(rolesFile, '{ "version": 1, 坏掉了');
    await expect(store.listRoles()).rejects.toBeInstanceOf(StorageCorruptJsonError);
    expect(await store.listRoles()).toEqual([]);
  });

  it("合法 JSON 但结构不符：顶层非对象 / version 不支持 / roles 非数组 / id 前缀非法均抛 typed error", async () => {
    await writeJsonAtomic(rolesFile, [1, 2, 3]);
    await expect(store.listRoles()).rejects.toBeInstanceOf(RolesFileInvalidError);

    await writeJsonAtomic(rolesFile, { version: 999, roles: [] });
    await expect(store.listRoles()).rejects.toMatchObject({
      code: "roles-file-invalid",
      path: rolesFile,
    });

    await writeJsonAtomic(rolesFile, { version: 1, roles: "不是数组" });
    await expect(store.listRoles()).rejects.toBeInstanceOf(RolesFileInvalidError);

    // id 是 RoleRef 的运行时判别依据，读入边界复核前缀
    await writeJsonAtomic(rolesFile, {
      version: 1,
      roles: [{ ...docDraft(), id: "planner", createdAt: 1, updatedAt: 1 }],
    });
    await expect(store.listRoles()).rejects.toBeInstanceOf(RolesFileInvalidError);
  });
});

describe("CRUD round-trip", () => {
  it("create → get → update（id / createdAt 不变，updatedAt 刷新）→ delete", async () => {
    let clock = 1_000;
    const timed = createRoleStore(rolesFile, () => clock);
    const created = await timed.createRole(docDraft());
    expect(created.createdAt).toBe(1_000);

    clock = 2_000;
    const updated = await timed.updateRole(created.id, {
      ...docDraft(),
      name: "文档撰写者 v2",
    });
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(1_000);
    expect(updated.updatedAt).toBe(2_000);
    expect(updated.name).toBe("文档撰写者 v2");
    expect(await timed.getRole(created.id)).toEqual(updated);

    await timed.deleteRole(created.id);
    expect(await timed.listRoles()).toEqual([]);
  });

  it("update / delete 的 id 不存在：抛 RoleNotFoundError（带 roleId）", async () => {
    const missing = "role-ffffffffffff" as CustomRoleId;
    await expect(store.updateRole(missing, docDraft())).rejects.toBeInstanceOf(RoleNotFoundError);
    await expect(store.deleteRole(missing)).rejects.toMatchObject({
      code: "role-not-found",
      roleId: missing,
    });
  });

  it("多条并存：id 互不相同，列表保序", async () => {
    const first = await store.createRole(docDraft());
    const second = await store.createRole(docDraft({ name: "翻译员" }));
    expect(first.id).not.toBe(second.id);
    expect((await store.listRoles()).map((role) => role.name)).toEqual(["文档撰写者", "翻译员"]);
  });
});

describe("注入校验回调（core 校验器接线口）", () => {
  it("回调抛错：create / update 原样上行且不落盘", async () => {
    const reject = (): never => {
      throw new Error("校验失败：名称不能为空");
    };
    await expect(store.createRole(docDraft({ name: "" }), reject)).rejects.toThrow("校验失败");
    expect(await store.listRoles()).toEqual([]);

    const created = await store.createRole(docDraft());
    await expect(store.updateRole(created.id, docDraft({ name: "" }), reject)).rejects.toThrow(
      "校验失败",
    );
    expect(await store.getRole(created.id)).toEqual(created);
  });

  it("异步回调同样生效", async () => {
    const rejectAsync = async (): Promise<void> => {
      throw new Error("异步拒绝");
    };
    await expect(store.createRole(docDraft(), rejectAsync)).rejects.toThrow("异步拒绝");
    expect(await store.listRoles()).toEqual([]);
  });
});

describe("删除保护（T8.4 口径：被 Profile 引用拒删）", () => {
  function profileBoundTo(roleId: CustomRoleId): AgentProfile {
    return {
      id: "profile-000000000001" as ProfileId,
      name: "文档 Agent",
      runtime: "codex",
      providerId: "provider-000000000001" as ProviderId,
      defaultRole: roleId,
      permissionPreset: DOC_PRESET,
    };
  }

  it("profileReferencesRole：defaultRole 指向该角色为 true，内置角色 Profile 不算", async () => {
    const created = await store.createRole(docDraft());
    expect(profileReferencesRole([profileBoundTo(created.id)], created.id)).toBe(true);
    expect(
      profileReferencesRole(
        [{ ...profileBoundTo(created.id), defaultRole: "planner" }],
        created.id,
      ),
    ).toBe(false);
    expect(profileReferencesRole([], created.id)).toBe(false);
  });

  it("isInUse 判定被引用：deleteRole 抛 RoleInUseError 且条目保留", async () => {
    const created = await store.createRole(docDraft());
    await expect(
      store.deleteRole(created.id, (id) => profileReferencesRole([profileBoundTo(id)], id)),
    ).rejects.toBeInstanceOf(RoleInUseError);
    expect(await store.getRole(created.id)).toEqual(created);
  });

  it("解绑后（钩子返回 false）即可删除；异步钩子同样生效", async () => {
    const created = await store.createRole(docDraft());
    await store.deleteRole(created.id, async () => false);
    expect(await store.listRoles()).toEqual([]);
  });
});
