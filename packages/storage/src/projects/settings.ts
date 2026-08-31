/**
 * project.json 持久化（项目级配置，设计文档 §10.2）：整文件原子读写 + 非破坏性部分更新。
 *
 * 为什么是「非破坏性」而不是照搬 config/store 的整体覆盖：`project.json` 的完整形态是
 * {@link import("@ff-pane/shared").Project}（角色绑定 / 权限策略 / 输出语言覆盖），而这些字段各归其工单、
 * 迄今都还没有写者。本层是第一个写它的人，只认识 `knowledgeToolEnabled` 一个字段——
 * 若按「读出已知字段 → 整体写回」的写法，将来别的工单写进去的字段会被本层的每次写入
 * 抹掉一遍，且是静默的。故读入时保留全部未知键，写回时只覆盖本层拥有的键。
 *
 * 其余约定沿用 providers / config / sessions 三层的既有形状：整文件 `{ version, project }`
 * 原子写；文件不存在视为「全用缺省」（首次 update 自动建档）；JSON 语法损坏由 W1.2a 隔离
 * 并上抛 StorageCorruptJsonError；结构不符抛 {@link ProjectSettingsFileInvalidError}。
 */

import type { ProfileId } from "@ff-pane/shared";
import { readJson, writeJsonAtomic } from "../fs/index.js";
import { ProjectSettingsFileInvalidError } from "./errors.js";

/** project.json 的当前格式版本。 */
export const PROJECT_SETTINGS_FILE_VERSION = 1;

/**
 * 本层认识并负责读写的 project.json 字段子集。
 *
 * 刻意不等同于完整 `Project`：那个类型含 id/name/rootPath/roleBindings 等尚无写者的字段，
 * 在这里把它们列成必填只会逼出一堆假值。等各自工单接手时再往这里加字段即可。
 */
export interface ProjectSettings {
  /**
   * 设计文档 §8.3.5 路径二 —— Agent 只读知识库检索工具的项目级开关。
   * **缺省 false（默认关闭）**：这是设计明写的默认，不是实现偷懒。
   */
  readonly knowledgeToolEnabled: boolean;
  /**
   * 设计文档 §3.1 —— Reviewer 角色的项目级开关（T7.2）。
   * **缺省 false（默认关闭）**：§3.1 角色表里 Reviewer 一栏写的就是"可选，默认关闭"。
   */
  readonly reviewerEnabled: boolean;
  /**
   * 设计文档 §3.1 / §10.2 —— Reviewer 绑定的 Profile（`RoleBindings.reviewer`）。
   *
   * 与开关**分开存**，且关掉开关不清除绑定：审查是一件用户会反复开开关关的事
   * （"这个任务重要，让它审一下"），每次重开都要重选一遍审查者是纯粹的摩擦。
   * 因此"没有 Reviewer"由 `reviewerEnabled: false` 表达，而不是由绑定缺席表达——
   * 本层也就不需要一个"清除绑定"的通道（换绑定直接覆盖即可）。
   *
   * 绑定的 Profile 事后被删除时，本字段会指向一个不存在的 ID。那属于**发起审查时**
   * 才需要处理的问题（编排层加载 Profile 失败会如实报"Profile 不存在"），不该由
   * 存储层在每次读取时去校验——存储层不认识 Profile 表。
   */
  readonly reviewerProfileId?: ProfileId;
}

/** 出厂缺省：两个工具/角色开关均默认关闭，Reviewer 未绑定。 */
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  knowledgeToolEnabled: false,
  reviewerEnabled: false,
};

/** 项目级配置存取接口（消费方：会话编排器、项目设置界面）。 */
export interface ProjectSettingsStore {
  /** 读取本层认识的字段。文件 / 字段缺失一律补缺省，调用方拿到的永远完整。 */
  readSettings(): Promise<ProjectSettings>;
  /** 合并补丁并原子写回（保留未知键），返回合并后的完整设置。 */
  updateSettings(patch: Partial<ProjectSettings>): Promise<ProjectSettings>;
}

/** 读入 `project` 对象原文（含未知键）。not-found 归一为空对象。 */
async function loadRaw(projectFile: string): Promise<Record<string, unknown>> {
  const result = await readJson<unknown>(projectFile);
  if (!result.ok) {
    if (result.error.code === "not-found") {
      return {};
    }
    throw result.error;
  }
  const raw = result.value;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProjectSettingsFileInvalidError(projectFile, "顶层必须是对象");
  }
  const file = raw as { readonly version?: unknown; readonly project?: unknown };
  if (file.version !== PROJECT_SETTINGS_FILE_VERSION) {
    throw new ProjectSettingsFileInvalidError(
      projectFile,
      `不支持的 version：${String(file.version)}（当前支持 ${PROJECT_SETTINGS_FILE_VERSION}）`,
    );
  }
  if (typeof file.project !== "object" || file.project === null || Array.isArray(file.project)) {
    throw new ProjectSettingsFileInvalidError(projectFile, "project 必须是对象");
  }
  return { ...(file.project as Record<string, unknown>) };
}

/** 取一个布尔字段；类型不符按「当它没写」处理（理由见 pickSettings）。 */
function pickBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key];
  return typeof value === "boolean" ? value : fallback;
}

/**
 * 从原文解出本层字段。
 * 类型不符的值按「当它没写」处理而不是抛错：这些是开关与一个 ID，手改坏了不该让整个
 * 项目打不开，而缺省都是安全的一侧（关闭 / 未绑定）。真正会破坏后续消费的结构问题
 * （顶层/version/project）才抛。
 */
function pickSettings(raw: Record<string, unknown>): ProjectSettings {
  const reviewerProfileId = raw["reviewerProfileId"];
  return {
    knowledgeToolEnabled: pickBoolean(
      raw,
      "knowledgeToolEnabled",
      DEFAULT_PROJECT_SETTINGS.knowledgeToolEnabled,
    ),
    reviewerEnabled: pickBoolean(raw, "reviewerEnabled", DEFAULT_PROJECT_SETTINGS.reviewerEnabled),
    ...(typeof reviewerProfileId === "string" && reviewerProfileId.length > 0
      ? { reviewerProfileId: reviewerProfileId as ProfileId }
      : {}),
  };
}

/**
 * 创建绑定到指定 project.json 路径的 ProjectSettingsStore。
 * 接线示例：`createProjectSettingsStore(resolveProjectLayout(root).projectFile)`。
 */
export function createProjectSettingsStore(projectFile: string): ProjectSettingsStore {
  return {
    async readSettings(): Promise<ProjectSettings> {
      return pickSettings(await loadRaw(projectFile));
    },

    async updateSettings(patch: Partial<ProjectSettings>): Promise<ProjectSettings> {
      const raw = await loadRaw(projectFile);
      const merged: ProjectSettings = { ...pickSettings(raw), ...patch };
      // 未知键原样带回，只覆盖本层拥有的键（见模块注释）
      await writeJsonAtomic(projectFile, {
        version: PROJECT_SETTINGS_FILE_VERSION,
        project: { ...raw, ...merged },
      });
      return merged;
    },
  };
}
