/**
 * profiles.json 持久化与 CRUD（W1.6）：设计文档 §4.4（Agent Profile）、
 * §10.1（全局数据布局，路径由 resolveGlobalLayout(root).profilesFile 给出）。
 * 镜像 W1.5a providers 模式：整文件读写（version + 条目数组）走 W1.2a 的
 * writeJsonAtomic 原子写与 readJson 安全读；文件不存在视为空集；JSON 语法
 * 损坏隔离后向上传递 StorageCorruptJsonError；查询 not-found 归一为
 * 空集 / undefined，变更的业务失败抛 ProfileStoreError 子类。
 *
 * 与 W1.5a 的关键差异——校验走依赖注入：Profile 的领域校验（Provider 存在、
 * 模型 kind、角色、预设 ⊆ 角色默认信封）归 @ff-pane/core 的 profile 模块，
 * 而 core / storage 互不依赖，故 create / update 接受可选的校验回调
 * ProfileDraftValidator，由宿主把 core 的校验器接进来（拒绝 = 抛错，
 * 错误原样上行）；回调抛错时不落盘。
 *
 * id 策略沿用 providers：`profile-` 可读前缀 + 12 位十六进制随机段
 * （crypto.randomBytes 6 字节 = 48 bit），生成时对现有 id 查重兜底；
 * name 允许重复。updateProfile 同样是全量替换（id 不变）：
 * exactOptionalPropertyTypes 下 Partial 补丁无法表达「清除可选字段」
 * （如把 model 清空回退到 Provider 默认模型），且设置页（W3.2b）整表单提交。
 */

import { randomBytes } from "node:crypto";
import type { AgentProfile, ProfileId, ProviderId } from "@ff-pane/shared";
import { readJson, writeJsonAtomic } from "../fs/index.js";
import { ProfileNotFoundError, ProfilesFileInvalidError } from "./errors.js";

/** profiles.json 的当前格式版本。未来格式变更时在读入处显式迁移。 */
export const PROFILES_FILE_VERSION = 1;

/** profiles.json 的整文件结构：版本字段 + 条目数组。 */
export interface ProfilesFile {
  /** 文件格式版本（当前恒为 PROFILES_FILE_VERSION）。 */
  readonly version: typeof PROFILES_FILE_VERSION;
  /** 全部 Profile 条目。 */
  readonly profiles: readonly AgentProfile[];
}

/**
 * 创建 / 更新 Profile 时调用方提交的内容：除 id 外的全部字段（id 由本层生成）。
 * 与 core 侧 profile 模块的同名类型结构一致（TypeScript 结构化类型互通，
 * 两包互不 import 故各自声明）。
 */
export type ProfileDraft = Omit<AgentProfile, "id">;

/**
 * 校验回调：以抛错表达拒绝（错误原样上行，create / update 不落盘），
 * 正常返回即放行。宿主接线示例见 createProfileStore 注释。支持同步或异步。
 */
export type ProfileDraftValidator = (draft: ProfileDraft) => void | Promise<void>;

/** Profile CRUD 存取接口（消费方：W3.2b 设置页、Phase 4 Prompt 组装）。 */
export interface ProfileStore {
  /** 列出全部 Profile。文件不存在视为空集（首次使用路径）。 */
  listProfiles(): Promise<readonly AgentProfile[]>;
  /** 按 id 查询。不存在返回 undefined（查询是常态分支，不抛错）。 */
  getProfile(id: ProfileId): Promise<AgentProfile | undefined>;
  /**
   * 新增条目，id 由本层生成。返回落盘后的完整 Profile。
   * 传入 validateDraft 时先行校验，回调抛错则不落盘。
   */
  createProfile(draft: ProfileDraft, validateDraft?: ProfileDraftValidator): Promise<AgentProfile>;
  /**
   * 全量替换 id 对应的条目（id 不变）。id 不存在抛 ProfileNotFoundError；
   * 传入 validateDraft 时先行校验，回调抛错则不落盘。
   */
  updateProfile(
    id: ProfileId,
    draft: ProfileDraft,
    validateDraft?: ProfileDraftValidator,
  ): Promise<AgentProfile>;
  /** 删除条目。id 不存在抛 ProfileNotFoundError。 */
  deleteProfile(id: ProfileId): Promise<void>;
}

/**
 * 是否有 Profile 引用指定 Provider。供宿主组装 W1.5a deleteProvider 的
 * 删除保护钩子（ProviderInUseCheck），接线示例：
 * `providerStore.deleteProvider(id, async (pid) =>
 *    profileReferencesProvider(await profileStore.listProfiles(), pid))`。
 */
export function profileReferencesProvider(
  profiles: readonly AgentProfile[],
  providerId: ProviderId,
): boolean {
  return profiles.some((profile) => profile.providerId === providerId);
}

const PROFILE_ID_PREFIX = "profile";
const PROFILE_ID_RANDOM_BYTES = 6;

/** 生成新的 Profile ID：可读前缀 + 随机段，对现有 id 查重（见模块注释）。 */
function generateProfileId(existingIds: ReadonlySet<string>): ProfileId {
  let id: string;
  do {
    id = `${PROFILE_ID_PREFIX}-${randomBytes(PROFILE_ID_RANDOM_BYTES).toString("hex")}`;
  } while (existingIds.has(id));
  return id as ProfileId;
}

/** 读入整文件并做结构检查。not-found 归一为空集，其余失败抛 typed error。 */
async function loadProfiles(profilesFile: string): Promise<readonly AgentProfile[]> {
  const result = await readJson<unknown>(profilesFile);
  if (!result.ok) {
    if (result.error.code === "not-found") {
      return [];
    }
    throw result.error;
  }
  const raw = result.value;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProfilesFileInvalidError(profilesFile, "顶层必须是对象");
  }
  const file = raw as { readonly version?: unknown; readonly profiles?: unknown };
  if (file.version !== PROFILES_FILE_VERSION) {
    throw new ProfilesFileInvalidError(
      profilesFile,
      `不支持的 version：${String(file.version)}（当前支持 ${PROFILES_FILE_VERSION}）`,
    );
  }
  if (!Array.isArray(file.profiles)) {
    throw new ProfilesFileInvalidError(profilesFile, "profiles 必须是数组");
  }
  // JSON 边界：条目写入时已经过宿主注入的校验，按 W1.1 约定 as 断言收窄品牌类型
  return file.profiles as readonly AgentProfile[];
}

/** 整文件原子写回（版本字段 + 条目数组）。 */
async function saveProfiles(
  profilesFile: string,
  profiles: readonly AgentProfile[],
): Promise<void> {
  const file: ProfilesFile = { version: PROFILES_FILE_VERSION, profiles };
  await writeJsonAtomic(profilesFile, file);
}

/**
 * 创建绑定到指定 profiles.json 路径的 ProfileStore。
 * 路径由宿主注入（接线示例：`createProfileStore(resolveGlobalLayout(root).profilesFile)`），
 * 与 W1.2a 布局层「根目录一律参数注入」的约定一致。
 * 校验回调的接线示例（宿主侧，core 的校验器 + 本层的 store）：
 * ```ts
 * const validate: ProfileDraftValidator = async (draft) => {
 *   const result = await validateProfileDraft(draft, {
 *     getProvider: (id) => providerStore.getProvider(id),
 *   });
 *   if (!result.ok) throw new ProfileValidationError(result.violations);
 * };
 * await profileStore.createProfile(draft, validate);
 * ```
 */
export function createProfileStore(profilesFile: string): ProfileStore {
  return {
    async listProfiles(): Promise<readonly AgentProfile[]> {
      return loadProfiles(profilesFile);
    },

    async getProfile(id: ProfileId): Promise<AgentProfile | undefined> {
      const profiles = await loadProfiles(profilesFile);
      return profiles.find((profile) => profile.id === id);
    },

    async createProfile(
      draft: ProfileDraft,
      validateDraft?: ProfileDraftValidator,
    ): Promise<AgentProfile> {
      if (validateDraft !== undefined) {
        await validateDraft(draft);
      }
      const profiles = await loadProfiles(profilesFile);
      const id = generateProfileId(new Set(profiles.map((profile) => profile.id)));
      const created: AgentProfile = { ...draft, id };
      await saveProfiles(profilesFile, [...profiles, created]);
      return created;
    },

    async updateProfile(
      id: ProfileId,
      draft: ProfileDraft,
      validateDraft?: ProfileDraftValidator,
    ): Promise<AgentProfile> {
      if (validateDraft !== undefined) {
        await validateDraft(draft);
      }
      const profiles = await loadProfiles(profilesFile);
      const index = profiles.findIndex((profile) => profile.id === id);
      if (index === -1) {
        throw new ProfileNotFoundError(id);
      }
      const updated: AgentProfile = { ...draft, id };
      await saveProfiles(profilesFile, profiles.with(index, updated));
      return updated;
    },

    async deleteProfile(id: ProfileId): Promise<void> {
      const profiles = await loadProfiles(profilesFile);
      if (!profiles.some((profile) => profile.id === id)) {
        throw new ProfileNotFoundError(id);
      }
      await saveProfiles(
        profilesFile,
        profiles.filter((profile) => profile.id !== id),
      );
    },
  };
}
