/**
 * W1.6 storage 侧单测：Profile CRUD 与 profiles.json 持久化，全部走 mkdtemp
 * 临时目录真实读写。覆盖：CRUD round-trip（含中文 name、可选字段缺省 / 清除）、
 * 首次使用空集、id 规则、注入校验回调（拒绝时不落盘、抛错原样上行）、
 * profileReferencesProvider 与 W1.5a 删除保护钩子的组装、
 * W1.2a 损坏隔离与结构不符的错误语义。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionEnvelope, ProfileId, ProviderId } from "@ff-pane/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProfileStore,
  createProviderStore,
  PROFILES_FILE_VERSION,
  type ProfileDraft,
  ProfileNotFoundError,
  type ProfileStore,
  ProfilesFileInvalidError,
  ProviderInUseError,
  profileReferencesProvider,
  resolveGlobalLayout,
  StorageCorruptJsonError,
  writeJsonAtomic,
  writeTextAtomic,
} from "../src/index.js";

let tempRoot: string;
let profilesFile: string;
let store: ProfileStore;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ff-pane-profiles-"));
  // 走 W1.2a 布局的规范路径，验证与 resolveGlobalLayout 的接线方式
  profilesFile = resolveGlobalLayout(join(tempRoot, ".aiworkbench")).profilesFile;
  store = createProfileStore(profilesFile);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const WORKER_PRESET: PermissionEnvelope = {
  readPaths: ["**"],
  writePaths: ["src/**"],
  shell: "allowed",
  network: false,
  dangerousOpsRequireApproval: true,
};

const PLANNER_PRESET: PermissionEnvelope = {
  readPaths: ["**"],
  writePaths: [],
  shell: "forbidden",
  network: true,
  dangerousOpsRequireApproval: true,
};

/** 可选字段齐全的草稿（§4.4 示例 "Claude 执行者" 同款结构）。 */
function workerDraft(): ProfileDraft {
  return {
    name: "Claude 执行者",
    runtime: "claude-code",
    providerId: "provider-3f2a9c1d8e4b" as ProviderId,
    model: "deepseek-chat",
    defaultRole: "worker",
    permissionPreset: WORKER_PRESET,
    outputLanguage: "zh-CN",
  };
}

/** 可选字段全缺省的草稿（model = 用 Provider 默认，输出语言 = 跟随全局）。 */
function plannerDraft(): ProfileDraft {
  return {
    name: "DeepSeek 规划",
    runtime: "opencode",
    providerId: "provider-9b8c7d6e5f4a" as ProviderId,
    defaultRole: "planner",
    permissionPreset: PLANNER_PRESET,
  };
}

describe("首次使用与文件持久化", () => {
  it("文件不存在视为空集：list 返回 []、get 返回 undefined，不抛错", async () => {
    expect(await store.listProfiles()).toEqual([]);
    expect(await store.getProfile("profile-000000000000" as ProfileId)).toBeUndefined();
  });

  it("首个 create 自动建档：落盘为 version 字段 + 条目数组", async () => {
    const created = await store.createProfile(workerDraft());
    const raw = JSON.parse(await readFile(profilesFile, "utf8")) as {
      version: number;
      profiles: unknown[];
    };
    expect(raw.version).toBe(PROFILES_FILE_VERSION);
    expect(raw.profiles).toHaveLength(1);
    expect(raw.profiles[0]).toEqual(created);
  });

  it("JSON 语法损坏：沿用 W1.2a 隔离语义并向上传递 StorageCorruptJsonError，之后回到空集", async () => {
    await writeTextAtomic(profilesFile, '{ "version": 1, 坏掉了');
    await expect(store.listProfiles()).rejects.toBeInstanceOf(StorageCorruptJsonError);
    // 原文件已被 W1.2a 隔离让位，下次读取走首次使用路径
    expect(await store.listProfiles()).toEqual([]);
  });

  it("合法 JSON 但结构不符：顶层非对象 / version 不支持 / profiles 非数组均抛 typed error", async () => {
    await writeJsonAtomic(profilesFile, [1, 2, 3]);
    await expect(store.listProfiles()).rejects.toBeInstanceOf(ProfilesFileInvalidError);

    await writeJsonAtomic(profilesFile, { version: 999, profiles: [] });
    await expect(store.listProfiles()).rejects.toMatchObject({
      code: "profiles-file-invalid",
      path: profilesFile,
    });

    await writeJsonAtomic(profilesFile, { version: 1, profiles: "不是数组" });
    await expect(store.listProfiles()).rejects.toBeInstanceOf(ProfilesFileInvalidError);
  });
});

describe("CRUD round-trip", () => {
  it("create → get / list 全字段保真（含中文 name、可选字段齐全与缺省两种）", async () => {
    const full = await store.createProfile(workerDraft());
    expect(full.name).toBe("Claude 执行者");
    expect(full.model).toBe("deepseek-chat");
    expect(full.outputLanguage).toBe("zh-CN");

    const minimal = await store.createProfile(plannerDraft());
    expect(minimal.model).toBeUndefined();
    expect(minimal.outputLanguage).toBeUndefined();

    expect(await store.getProfile(full.id)).toEqual(full);
    expect(await store.getProfile(minimal.id)).toEqual(minimal);
    expect(await store.listProfiles()).toEqual([full, minimal]);
  });

  it("id 策略：profile- 前缀 + 12 位十六进制随机段，多次创建互不相同", async () => {
    const first = await store.createProfile(workerDraft());
    const second = await store.createProfile(plannerDraft());
    const third = await store.createProfile(workerDraft());
    const ids = [first.id, second.id, third.id];
    for (const id of ids) {
      expect(id).toMatch(/^profile-[0-9a-f]{12}$/);
    }
    expect(new Set(ids).size).toBe(3);
  });

  it("name 允许重复，id 保持唯一", async () => {
    const a = await store.createProfile(workerDraft());
    const b = await store.createProfile(workerDraft());
    expect(a.name).toBe(b.name);
    expect(a.id).not.toBe(b.id);
    expect(await store.listProfiles()).toHaveLength(2);
  });

  it("update 全量替换（id 不变），可清除可选字段（model 回退 Provider 默认、语言回退全局）", async () => {
    const created = await store.createProfile(workerDraft());
    const updated = await store.updateProfile(created.id, plannerDraft());
    expect(updated.id).toBe(created.id);
    expect(updated.defaultRole).toBe("planner");
    expect(updated.model).toBeUndefined();
    expect(updated.outputLanguage).toBeUndefined();

    expect(await store.getProfile(created.id)).toEqual(updated);
    expect(await store.listProfiles()).toHaveLength(1);
  });

  it("update / delete 不存在的 id 抛 ProfileNotFoundError", async () => {
    const missing = "profile-ffffffffffff" as ProfileId;
    await expect(store.updateProfile(missing, workerDraft())).rejects.toMatchObject({
      code: "profile-not-found",
      profileId: missing,
    });
    await expect(store.deleteProfile(missing)).rejects.toBeInstanceOf(ProfileNotFoundError);
  });

  it("delete 后条目移除，其余条目保留", async () => {
    const keep = await store.createProfile(workerDraft());
    const drop = await store.createProfile(plannerDraft());
    await store.deleteProfile(drop.id);
    expect(await store.listProfiles()).toEqual([keep]);
    expect(await store.getProfile(drop.id)).toBeUndefined();
  });
});

describe("注入校验回调（领域校验归 core，宿主接线）", () => {
  class RejectedError extends Error {}

  it("create：回调抛错则拒绝且不落盘（文件不创建）", async () => {
    await expect(
      store.createProfile(workerDraft(), () => {
        throw new RejectedError("Provider 不存在");
      }),
    ).rejects.toBeInstanceOf(RejectedError);
    expect(await store.listProfiles()).toEqual([]);
    await expect(readFile(profilesFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("update：回调抛错则拒绝且原数据不变", async () => {
    const created = await store.createProfile(workerDraft());
    await expect(
      store.updateProfile(created.id, plannerDraft(), async () => {
        throw new RejectedError("预设越权");
      }),
    ).rejects.toBeInstanceOf(RejectedError);
    expect(await store.getProfile(created.id)).toEqual(created);
  });

  it("回调收到提交的草稿原件；异步回调放行后正常落盘", async () => {
    const received: ProfileDraft[] = [];
    const draft = workerDraft();
    const created = await store.createProfile(draft, async (submitted) => {
      received.push(submitted);
    });
    expect(received).toEqual([draft]);
    expect(await store.getProfile(created.id)).toEqual(created);
  });

  it("未传回调时不做领域校验，直接落盘（storage 不 import core）", async () => {
    const created = await store.createProfile(workerDraft());
    expect(await store.listProfiles()).toEqual([created]);
  });
});

describe("profileReferencesProvider 与 W1.5a 删除保护的组装", () => {
  it("引用判定：命中 providerId 返回 true，否则 false；空集恒 false", () => {
    const providerId = "provider-3f2a9c1d8e4b" as ProviderId;
    expect(profileReferencesProvider([], providerId)).toBe(false);

    const profile = { ...workerDraft(), id: "profile-aaaaaaaaaaaa" as ProfileId };
    expect(profileReferencesProvider([profile], providerId)).toBe(true);
    expect(profileReferencesProvider([profile], "provider-000000000000" as ProviderId)).toBe(false);
  });

  it("组装 deleteProvider 删除保护钩子：被 Profile 引用时拒删，解除引用后可删", async () => {
    const providerStore = createProviderStore(
      resolveGlobalLayout(join(tempRoot, ".aiworkbench")).providersFile,
    );
    const provider = await providerStore.createProvider({
      name: "Claude 订阅登录",
      type: "cli_login",
      models: [],
      enabled: true,
    });
    const profile = await store.createProfile({ ...workerDraft(), providerId: provider.id });

    // 宿主的接线方式：listProfiles 的结果交给 profileReferencesProvider
    const isInUse = async (id: ProviderId): Promise<boolean> =>
      profileReferencesProvider(await store.listProfiles(), id);

    await expect(providerStore.deleteProvider(provider.id, isInUse)).rejects.toBeInstanceOf(
      ProviderInUseError,
    );
    expect(await providerStore.getProvider(provider.id)).toEqual(provider);

    await store.deleteProfile(profile.id);
    await providerStore.deleteProvider(provider.id, isInUse);
    expect(await providerStore.listProviders()).toEqual([]);
  });
});
