/**
 * projects.json 持久化与增删（工作台项目注册表）：设计文档 §10.1 全局数据、
 * §11.1 项目列表页数据源。
 *
 * 设计决策（镜像 W1.5a providers/store 的既有模式）：
 * - 整文件读写：projects.json = `{ version, projects[] }`，经 W1.2a 的
 *   writeJsonAtomic 原子写与 readJson 安全读。文件不存在视为空集（首次使用
 *   路径，首个 add 自动落盘建档）；JSON 语法损坏由 W1.2a 隔离为
 *   `<原名>.corrupt-<时间戳>`，本层把 StorageCorruptJsonError 原样抛出向上传递。
 * - 注册表条目是 Project 的严格子集（ProjectRegistryEntry）：只存项目列表页
 *   需要的最小信息；角色绑定等完整配置随后写入项目自身的 project.json（不在本层）。
 * - 去重口径：以 rootPath 唯一。一个目录只能登记一次（避免重复卡片）；接线层在
 *   调用前用 path.resolve 归一，本层按字符串精确比较。
 * - id 策略：`project-` 可读前缀 + 12 位十六进制随机段（crypto.randomBytes 6 字节），
 *   生成时对现有 id 查重兜底；name 允许重复，id 由本层生成保证唯一。
 * - 错误语义：查询（list）把 not-found 归一为空集；变更（add / remove）的业务失败
 *   抛 ProjectRegistryError 子类，环境事故抛 W1.2a 的 StorageFsError 子类。
 * - 磁盘目录：本层只维护登记记录，不创建 / 不删除项目磁盘目录（`.workbench/` 的
 *   生成与移除语义归接线层：add 时宿主调 initProjectLayout，remove 只出注册表、
 *   不碰磁盘——设计系统 §6.3「移除项目」为可撤销操作，据此支持 restore）。
 */

import { randomBytes } from "node:crypto";
import type { EpochMillis, ProjectId, ProjectRegistryEntry } from "@ff-pane/shared";
import { readJson, writeJsonAtomic } from "../fs/index.js";
import {
  ProjectAlreadyRegisteredError,
  ProjectNotFoundError,
  ProjectsFileInvalidError,
} from "./errors.js";

/** projects.json 的当前格式版本。未来格式变更时在读入处显式迁移。 */
export const PROJECTS_FILE_VERSION = 1;

/** projects.json 的整文件结构：版本字段 + 条目数组。 */
export interface ProjectsFile {
  /** 文件格式版本（当前恒为 PROJECTS_FILE_VERSION）。 */
  readonly version: typeof PROJECTS_FILE_VERSION;
  /** 全部已登记项目条目。 */
  readonly projects: readonly ProjectRegistryEntry[];
}

/** 登记新项目所需的最小信息（id / createdAt 由本层生成）。 */
export interface ProjectRegistrationDraft {
  /** 项目显示名（默认取根目录名，可改）。 */
  readonly name: string;
  /** 项目根路径（接线层已 path.resolve 归一）。 */
  readonly rootPath: string;
}

/** 项目注册表存取接口（消费方：主进程 projects:* handlers、W3.3 项目列表页）。 */
export interface ProjectRegistry {
  /** 列出全部已登记项目（按登记时间升序）。文件不存在视为空集（首次使用路径）。 */
  listProjects(): Promise<readonly ProjectRegistryEntry[]>;
  /** 登记新项目，id 由本层生成。rootPath 已登记时抛 ProjectAlreadyRegisteredError。 */
  addProject(draft: ProjectRegistrationDraft): Promise<ProjectRegistryEntry>;
  /** 移除登记（不碰磁盘）。id 不存在抛 ProjectNotFoundError。返回被移除的条目供撤销。 */
  removeProject(id: ProjectId): Promise<ProjectRegistryEntry>;
  /**
   * 撤销移除：把先前 removeProject 返回的条目原样放回（保留 id / createdAt）。
   * 幂等：id 或 rootPath 已存在时不重复插入，直接返回现有条目。
   */
  restoreProject(entry: ProjectRegistryEntry): Promise<ProjectRegistryEntry>;
}

const PROJECT_ID_PREFIX = "project";
const PROJECT_ID_RANDOM_BYTES = 6;

/** 生成新的项目 ID：可读前缀 + 随机段，对现有 id 查重（见模块注释）。 */
function generateProjectId(existingIds: ReadonlySet<string>): ProjectId {
  let id: string;
  do {
    id = `${PROJECT_ID_PREFIX}-${randomBytes(PROJECT_ID_RANDOM_BYTES).toString("hex")}`;
  } while (existingIds.has(id));
  return id as ProjectId;
}

/** 读入整文件并做结构检查。not-found 归一为空集，其余失败抛 typed error。 */
async function loadProjects(projectsFile: string): Promise<readonly ProjectRegistryEntry[]> {
  const result = await readJson<unknown>(projectsFile);
  if (!result.ok) {
    if (result.error.code === "not-found") {
      return [];
    }
    throw result.error;
  }
  const raw = result.value;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProjectsFileInvalidError(projectsFile, "顶层必须是对象");
  }
  const file = raw as { readonly version?: unknown; readonly projects?: unknown };
  if (file.version !== PROJECTS_FILE_VERSION) {
    throw new ProjectsFileInvalidError(
      projectsFile,
      `不支持的 version：${String(file.version)}（当前支持 ${PROJECTS_FILE_VERSION}）`,
    );
  }
  if (!Array.isArray(file.projects)) {
    throw new ProjectsFileInvalidError(projectsFile, "projects 必须是数组");
  }
  // JSON 边界：条目写入时已由本层构造，按 W1.1 约定 as 断言收窄品牌类型
  return file.projects as readonly ProjectRegistryEntry[];
}

/** 整文件原子写回（版本字段 + 条目数组）。 */
async function saveProjects(
  projectsFile: string,
  projects: readonly ProjectRegistryEntry[],
): Promise<void> {
  const file: ProjectsFile = { version: PROJECTS_FILE_VERSION, projects };
  await writeJsonAtomic(projectsFile, file);
}

/**
 * 创建绑定到指定 projects.json 路径的 ProjectRegistry。
 * 路径由宿主注入（接线示例：`createProjectRegistry(resolveGlobalLayout(root).projectsFile)`），
 * 与 W1.2a 布局层「根目录一律参数注入」的约定一致。
 *
 * `now` 可注入时钟（默认 Date.now），便于单测断言 createdAt。
 */
export function createProjectRegistry(
  projectsFile: string,
  now: () => EpochMillis = Date.now,
): ProjectRegistry {
  return {
    async listProjects(): Promise<readonly ProjectRegistryEntry[]> {
      return loadProjects(projectsFile);
    },

    async addProject(draft: ProjectRegistrationDraft): Promise<ProjectRegistryEntry> {
      const projects = await loadProjects(projectsFile);
      if (projects.some((project) => project.rootPath === draft.rootPath)) {
        throw new ProjectAlreadyRegisteredError(draft.rootPath);
      }
      const id = generateProjectId(new Set(projects.map((project) => project.id)));
      const created: ProjectRegistryEntry = {
        id,
        name: draft.name,
        rootPath: draft.rootPath,
        createdAt: now(),
      };
      await saveProjects(projectsFile, [...projects, created]);
      return created;
    },

    async removeProject(id: ProjectId): Promise<ProjectRegistryEntry> {
      const projects = await loadProjects(projectsFile);
      const removed = projects.find((project) => project.id === id);
      if (removed === undefined) {
        throw new ProjectNotFoundError(id);
      }
      await saveProjects(
        projectsFile,
        projects.filter((project) => project.id !== id),
      );
      return removed;
    },

    async restoreProject(entry: ProjectRegistryEntry): Promise<ProjectRegistryEntry> {
      const projects = await loadProjects(projectsFile);
      const existing = projects.find(
        (project) => project.id === entry.id || project.rootPath === entry.rootPath,
      );
      if (existing !== undefined) {
        return existing;
      }
      await saveProjects(projectsFile, [...projects, entry]);
      return entry;
    },
  };
}
