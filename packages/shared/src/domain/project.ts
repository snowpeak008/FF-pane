/**
 * 项目（设计文档 §3、§10.2 project.json）。
 * Project 是路径、计划、任务、记忆、配置的边界；计划/任务/Run/记忆等记录
 * 存放于项目目录内（§10.2），因此这些记录类型不重复携带 projectId。
 */

import type { EpochMillis, ProfileId, ProjectId } from "./common.js";
import type { AiOutputLanguage } from "./language.js";
import type { PermissionEnvelope } from "./permission.js";
import type { Role } from "./profile.js";

/**
 * 设计文档 §3 / §12 步骤 1 —— 项目的角色绑定：`Planner → 某个 Profile`。
 * planner 与 worker 必须绑定；reviewer 可选（§3.1，默认关闭）。
 * 换 AI = 换绑定，一个下拉框完成（§4.4）。
 */
export interface RoleBindings {
  /** 设计文档 §3.1 —— Planner 绑定的 Profile（必须）。 */
  readonly planner: ProfileId;
  /** 设计文档 §3.1 —— Worker 绑定的 Profile（必须）。 */
  readonly worker: ProfileId;
  /** 设计文档 §3.1 —— Reviewer 绑定的 Profile（可选，默认关闭）。 */
  readonly reviewer?: ProfileId;
}

/**
 * 设计文档 §3 / §10.2 —— 项目配置（project.json 的领域形态）：
 * 角色绑定、输出语言覆盖、权限策略。
 * 项目卡片上的派生信息（当前计划版本、进行中任务数、最后活动时间，§11.1）
 * 由查询层从计划/任务/Run 记录汇总，不在此持久化。
 */
export interface Project {
  /** 设计文档 §3 —— 项目内部唯一 ID。 */
  readonly id: ProjectId;
  /** 设计文档 §11.1 —— 项目显示名。 */
  readonly name: string;
  /** 设计文档 §3 —— 项目根路径（`.workbench/` 的宿主目录，§10.2）。 */
  readonly rootPath: string;
  /** 设计文档 §10.2 —— 角色绑定。 */
  readonly roleBindings: RoleBindings;
  /** 设计文档 §10.2 / §9.2 —— 项目级输出语言覆盖（缺省 = 继承 Profile/全局）。 */
  readonly outputLanguage?: AiOutputLanguage;
  /**
   * 设计文档 §10.2 —— 项目级权限策略：按角色覆盖默认权限信封。
   * （设计文档仅写"权限策略"四字，此为最合理解释，详见 W1.1 报告争议点。）
   */
  readonly permissionPolicy?: Partial<Record<Role, PermissionEnvelope>>;
  /**
   * 设计文档 §8.3.5 路径二 —— Agent 只读知识库检索工具的项目级开关，
   * 缺省 = false（默认关闭）。
   */
  readonly knowledgeToolEnabled?: boolean;
  /** 项目在工作台的登记时间（epoch 毫秒）。 */
  readonly createdAt: EpochMillis;
}

/**
 * 工作台"已登记项目"的注册表条目（全局 §10.1 projects.json）。
 *
 * 与完整 {@link Project}（项目内 §10.2 project.json）区分：注册表只回答项目列表页
 * （§11.1「我有哪些项目」）需要的最小信息——身份、显示名、根路径、登记时间；
 * 角色绑定 / 权限策略 / 输出语言等完整配置随后写入项目自身的 project.json，
 * 依赖 Profile 存在，故不在登记时强求。ProjectRegistryEntry 是 Project 的严格子集。
 */
export interface ProjectRegistryEntry {
  /** 项目内部唯一 ID（与最终 project.json 的 id 一致）。 */
  readonly id: ProjectId;
  /** 项目显示名（默认取根目录名，可改）。 */
  readonly name: string;
  /** 项目根路径（`.workbench/` 的宿主目录，§10.2）。 */
  readonly rootPath: string;
  /** 项目登记进工作台的时间（epoch 毫秒）。 */
  readonly createdAt: EpochMillis;
}
