/**
 * 项目注册表层错误类型，沿用 W1.2a / W1.5a 的错误设计模式：
 * Error 子类 + `code` 字面量判别字段，既能 instanceof 捕获，又能在联合类型上
 * 用 `error.code` 穷尽分支。文件系统故障不在此重复定义——store 层直接向上传递
 * W1.2a 的 StorageFsError 错误族。
 */

import type { ProjectId } from "@ff-pane/shared";

/** 项目注册表层错误码（判别字段的取值全集）。 */
export const PROJECT_REGISTRY_ERROR_CODES = [
  "project-already-registered",
  "project-not-found",
  "projects-file-invalid",
  "project-settings-file-invalid",
] as const;

/** 项目注册表层错误码。 */
export type ProjectRegistryErrorCode = (typeof PROJECT_REGISTRY_ERROR_CODES)[number];

/** 项目注册表层错误基类。 */
export abstract class ProjectRegistryError extends Error {
  /** 判别字段：各子类收窄为字面量类型，供联合类型穷尽分支。 */
  abstract readonly code: ProjectRegistryErrorCode;

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * 同一根路径已登记：一个目录只能在工作台登记一次（避免重复卡片、避免歧义）。
 * 判定用规范化后的绝对路径（接线层在调用前 path.resolve 归一）。
 */
export class ProjectAlreadyRegisteredError extends ProjectRegistryError {
  override readonly code = "project-already-registered" as const;
  /** 已登记的项目根路径。 */
  readonly rootPath: string;

  constructor(rootPath: string) {
    super(`项目已登记: ${rootPath}`);
    this.rootPath = rootPath;
  }
}

/** 目标项目不存在（remove 的失败分支；list 查询不抛此错误）。 */
export class ProjectNotFoundError extends ProjectRegistryError {
  override readonly code = "project-not-found" as const;
  /** 未命中的项目 ID。 */
  readonly projectId: ProjectId;

  constructor(projectId: ProjectId) {
    super(`项目不存在: ${projectId}`);
    this.projectId = projectId;
  }
}

/**
 * projects.json 是合法 JSON 但整文件结构不符合约定（顶层非对象、版本不支持、
 * projects 非数组）。与 JSON 语法损坏不同：语法损坏由 W1.2a 隔离并抛
 * StorageCorruptJsonError；结构不符不隔离（内容对用户仍有价值，留在原地人工修复）。
 */
export class ProjectsFileInvalidError extends ProjectRegistryError {
  override readonly code = "projects-file-invalid" as const;
  /** 出错的 projects.json 路径。 */
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`projects.json 结构不符合约定（${reason}）: ${path}`);
    this.path = path;
  }
}

/**
 * 项目级 project.json 是合法 JSON 但整文件结构不符合约定（顶层非对象、版本不支持、
 * project 非对象）。与上者同一处置纪律：结构不符不隔离，留在原地人工修复——
 * 这个文件将来还要装角色绑定与权限策略，自动挪走的代价比让用户改一行大得多。
 */
export class ProjectSettingsFileInvalidError extends ProjectRegistryError {
  override readonly code = "project-settings-file-invalid" as const;
  /** 出错的 project.json 路径。 */
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`project.json 结构不符合约定（${reason}）: ${path}`);
    this.path = path;
  }
}
