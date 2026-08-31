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
}

/** 出厂缺省：工具默认关闭。 */
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  knowledgeToolEnabled: false,
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

/**
 * 从原文解出本层字段。
 * 类型不符的值按「当它没写」处理而不是抛错：这是个布尔开关，手改坏了不该让整个项目打不开，
 * 而缺省是安全的一侧（关闭）。真正会破坏后续消费的结构问题（顶层/version/project）才抛。
 */
function pickSettings(raw: Record<string, unknown>): ProjectSettings {
  const enabled = raw["knowledgeToolEnabled"];
  return {
    knowledgeToolEnabled:
      typeof enabled === "boolean" ? enabled : DEFAULT_PROJECT_SETTINGS.knowledgeToolEnabled,
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
