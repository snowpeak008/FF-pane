/**
 * roles.json 持久化与 CRUD（T8.4）：设计文档 §3.1 自定义角色（名称 + 角色提示词 +
 * 权限预设），全局存储（§10.1 布局，路径由 resolveGlobalLayout(root).rolesFile 给出）。
 * 镜像 W1.6 profiles 模式：整文件读写（version + 条目数组）走 W1.2a 的
 * writeJsonAtomic 原子写与 readJson 安全读；文件不存在视为空集；JSON 语法
 * 损坏隔离后向上传递 StorageCorruptJsonError；查询 not-found 归一为
 * 空集 / undefined，变更的业务失败抛 RoleStoreError 子类。
 *
 * 校验走依赖注入（与 profiles 同款）：预设合规（不得宽于用户权限上限、§7 危险
 * 清单不可关闭）归 @ff-pane/core 的 role 校验器，core / storage 互不依赖，故
 * create / update 接受可选的校验回调（拒绝 = 抛错，错误原样上行；回调抛错不落盘）。
 *
 * id 策略沿用 profiles：`role-` 可读前缀 + 12 位十六进制随机段，生成时对现有 id
 * 查重兜底；前缀同时是 RoleRef 的运行时判别（shared isCustomRoleId），故必须与
 * shared 的 CUSTOM_ROLE_ID_PREFIX 一致。updateRole 同样是全量替换（id / createdAt
 * 不变）：exactOptionalPropertyTypes 下 Partial 补丁表达力不足，且设置页整表单提交。
 *
 * 删除口径（T8.4 决策，落档进度文档）：被 Profile 引用（defaultRole 指向该角色）
 * 时**拒绝删除**（RoleInUseError），与 Provider 删除保护同款——级联会静默改写
 * Profile 语义，拒删让引用关系始终显式。引用检查经删除保护钩子注入（宿主把
 * profileReferencesRole 接进来），本层不读 profiles.json。
 */

import { randomBytes } from "node:crypto";
import type { AgentProfile, CustomRole, CustomRoleId } from "@ff-pane/shared";
import { CUSTOM_ROLE_ID_PREFIX, isCustomRoleId } from "@ff-pane/shared";
import { readJson, writeJsonAtomic } from "../fs/index.js";
import { RoleInUseError, RoleNotFoundError, RolesFileInvalidError } from "./errors.js";

/** roles.json 的当前格式版本。未来格式变更时在读入处显式迁移。 */
export const ROLES_FILE_VERSION = 1;

/** roles.json 的整文件结构：版本字段 + 条目数组。 */
export interface RolesFile {
  /** 文件格式版本（当前恒为 ROLES_FILE_VERSION）。 */
  readonly version: typeof ROLES_FILE_VERSION;
  /** 全部自定义角色条目。 */
  readonly roles: readonly CustomRole[];
}

/**
 * 创建 / 更新角色时调用方提交的内容：名称 + 提示词 + 预设
 * （id 与时间戳由本层生成 / 维护）。
 */
export type CustomRoleDraft = Omit<CustomRole, "id" | "createdAt" | "updatedAt">;

/**
 * 校验回调：以抛错表达拒绝（错误原样上行，create / update 不落盘），
 * 正常返回即放行。宿主接线示例见 createRoleStore 注释。支持同步或异步。
 */
export type RoleDraftValidator = (draft: CustomRoleDraft) => void | Promise<void>;

/** 删除保护钩子：返回 true 表示该角色正被引用，deleteRole 拒删。 */
export type RoleInUseCheck = (id: CustomRoleId) => boolean | Promise<boolean>;

/** 自定义角色 CRUD 存取接口（消费方：T8.4 设置页角色管理、编排器角色解析）。 */
export interface RoleStore {
  /** 列出全部自定义角色。文件不存在视为空集（首次使用路径）。 */
  listRoles(): Promise<readonly CustomRole[]>;
  /** 按 id 查询。不存在返回 undefined（查询是常态分支，不抛错）。 */
  getRole(id: CustomRoleId): Promise<CustomRole | undefined>;
  /**
   * 新增条目，id 与时间戳由本层生成。返回落盘后的完整角色。
   * 传入 validateDraft 时先行校验，回调抛错则不落盘。
   */
  createRole(draft: CustomRoleDraft, validateDraft?: RoleDraftValidator): Promise<CustomRole>;
  /**
   * 全量替换 id 对应的条目（id / createdAt 不变，updatedAt 由本层刷新）。
   * id 不存在抛 RoleNotFoundError；传入 validateDraft 时先行校验。
   */
  updateRole(
    id: CustomRoleId,
    draft: CustomRoleDraft,
    validateDraft?: RoleDraftValidator,
  ): Promise<CustomRole>;
  /**
   * 删除条目。id 不存在抛 RoleNotFoundError；
   * 传入 isInUse 且判定被引用时抛 RoleInUseError（删除保护）。
   */
  deleteRole(id: CustomRoleId, isInUse?: RoleInUseCheck): Promise<void>;
}

/**
 * 是否有 Profile 绑定指定自定义角色（defaultRole 指向它）。供宿主组装
 * deleteRole 的删除保护钩子，接线示例：
 * `roleStore.deleteRole(id, async (rid) =>
 *    profileReferencesRole(await profileStore.listProfiles(), rid))`。
 */
export function profileReferencesRole(
  profiles: readonly AgentProfile[],
  roleId: CustomRoleId,
): boolean {
  return profiles.some((profile) => profile.defaultRole === roleId);
}

const ROLE_ID_RANDOM_BYTES = 6;

/** 生成新的角色 ID：`role-` 前缀 + 随机段，对现有 id 查重（见模块注释）。 */
function generateRoleId(existingIds: ReadonlySet<string>): CustomRoleId {
  let id: string;
  do {
    id = `${CUSTOM_ROLE_ID_PREFIX}${randomBytes(ROLE_ID_RANDOM_BYTES).toString("hex")}`;
  } while (existingIds.has(id));
  return id as CustomRoleId;
}

/** 读入整文件并做结构检查。not-found 归一为空集，其余失败抛 typed error。 */
async function loadRoles(rolesFile: string): Promise<readonly CustomRole[]> {
  const result = await readJson<unknown>(rolesFile);
  if (!result.ok) {
    if (result.error.code === "not-found") {
      return [];
    }
    throw result.error;
  }
  const raw = result.value;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RolesFileInvalidError(rolesFile, "顶层必须是对象");
  }
  const file = raw as { readonly version?: unknown; readonly roles?: unknown };
  if (file.version !== ROLES_FILE_VERSION) {
    throw new RolesFileInvalidError(
      rolesFile,
      `不支持的 version：${String(file.version)}（当前支持 ${ROLES_FILE_VERSION}）`,
    );
  }
  if (!Array.isArray(file.roles)) {
    throw new RolesFileInvalidError(rolesFile, "roles 必须是数组");
  }
  // id 是 RoleRef 的运行时判别依据，读入边界复核前缀（与 sessions store 校验 role 同款）；
  // 其余字段写入时已经过宿主注入的校验，按 W1.1 约定 as 断言收窄品牌类型
  const roles = file.roles as readonly CustomRole[];
  for (const role of roles) {
    if (!isCustomRoleId(role.id)) {
      throw new RolesFileInvalidError(
        rolesFile,
        `角色 id 非法（须以 role- 前缀）：${String(role.id)}`,
      );
    }
  }
  return roles;
}

/** 整文件原子写回（版本字段 + 条目数组）。 */
async function saveRoles(rolesFile: string, roles: readonly CustomRole[]): Promise<void> {
  const file: RolesFile = { version: ROLES_FILE_VERSION, roles };
  await writeJsonAtomic(rolesFile, file);
}

/**
 * 创建绑定到指定 roles.json 路径的 RoleStore。
 * 路径由宿主注入（接线示例：`createRoleStore(resolveGlobalLayout(root).rolesFile)`），
 * 与 W1.2a 布局层「根目录一律参数注入」的约定一致。
 * 校验回调的接线示例（宿主侧，core 的校验器 + 本层的 store）：
 * ```ts
 * const validate: RoleDraftValidator = async (draft) => {
 *   const result = validateCustomRoleDraft(draft, { userCeiling });
 *   if (!result.ok) throw new CustomRoleValidationError(result.violations);
 * };
 * await roleStore.createRole(draft, validate);
 * ```
 */
export function createRoleStore(rolesFile: string, now: () => number = Date.now): RoleStore {
  return {
    async listRoles(): Promise<readonly CustomRole[]> {
      return loadRoles(rolesFile);
    },

    async getRole(id: CustomRoleId): Promise<CustomRole | undefined> {
      const roles = await loadRoles(rolesFile);
      return roles.find((role) => role.id === id);
    },

    async createRole(
      draft: CustomRoleDraft,
      validateDraft?: RoleDraftValidator,
    ): Promise<CustomRole> {
      if (validateDraft !== undefined) {
        await validateDraft(draft);
      }
      const roles = await loadRoles(rolesFile);
      const id = generateRoleId(new Set(roles.map((role) => role.id)));
      const at = now();
      const created: CustomRole = { ...draft, id, createdAt: at, updatedAt: at };
      await saveRoles(rolesFile, [...roles, created]);
      return created;
    },

    async updateRole(
      id: CustomRoleId,
      draft: CustomRoleDraft,
      validateDraft?: RoleDraftValidator,
    ): Promise<CustomRole> {
      if (validateDraft !== undefined) {
        await validateDraft(draft);
      }
      const roles = await loadRoles(rolesFile);
      const index = roles.findIndex((role) => role.id === id);
      const existing = roles[index];
      if (index === -1 || existing === undefined) {
        throw new RoleNotFoundError(id);
      }
      const updated: CustomRole = {
        ...draft,
        id,
        createdAt: existing.createdAt,
        updatedAt: now(),
      };
      await saveRoles(rolesFile, roles.with(index, updated));
      return updated;
    },

    async deleteRole(id: CustomRoleId, isInUse?: RoleInUseCheck): Promise<void> {
      const roles = await loadRoles(rolesFile);
      if (!roles.some((role) => role.id === id)) {
        throw new RoleNotFoundError(id);
      }
      if (isInUse !== undefined && (await isInUse(id))) {
        throw new RoleInUseError(id);
      }
      await saveRoles(
        rolesFile,
        roles.filter((role) => role.id !== id),
      );
    },
  };
}
