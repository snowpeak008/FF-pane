/**
 * 目录布局（W1.2a）：设计文档 §10.1 全局数据（~/.aiworkbench）与
 * §10.2 项目数据（<项目目录>/.workbench）的路径解析与幂等初始化。
 *
 * 根目录一律参数注入：本库不读 homedir / Electron API，宿主（apps/desktop 主进程）
 * 在接线时给出 rootDir（归后续工单）。
 * 初始化只补建目录、不创建任何文件：config.json / providers.json（W1.5a）、
 * project.json / state.md 等（W1.2b/c）、index.sqlite（W1.3a）各归其工单，
 * 布局记录仅给出这些文件的规范路径。
 */

import { join } from "node:path";
import type { HabitCategory, MemoryCategory } from "@ff-pane/shared";
import { HABIT_CATEGORIES } from "@ff-pane/shared";
import { ensureDir } from "./atomic.js";

/**
 * 全局数据目录的规范名（设计文档 §10.1）。
 * 宿主接线示例：`resolveGlobalLayout(join(homedir(), GLOBAL_ROOT_DIR_NAME))`。
 */
export const GLOBAL_ROOT_DIR_NAME = ".aiworkbench";

/** 项目数据目录的规范名（设计文档 §10.2：<项目目录>/.workbench）。 */
export const WORKBENCH_DIR_NAME = ".workbench";

/** 以独立目录持久化的项目记忆分类（state 是单文件 state.md，不设目录）。 */
export type MemoryDirCategory = Exclude<MemoryCategory, "state">;

/** 记忆分类 → 目录名（设计文档 §10.2：目录名取复数）。 */
const MEMORY_DIR_NAMES: Readonly<Record<MemoryDirCategory, string>> = {
  decision: "decisions",
  rule: "rules",
  lesson: "lessons",
};

/** 全局数据布局路径记录（设计文档 §10.1）。所有成员由注入的 rootDir 派生。 */
export interface GlobalLayout {
  /** 注入的全局根目录（如 %USERPROFILE%\.aiworkbench）。 */
  readonly rootDir: string;
  /** config.json —— 全局设置：界面语言、AI 输出语言、默认权限预设。 */
  readonly configFile: string;
  /** projects.json —— 工作台已登记项目注册表（§11.1 项目列表页数据源）。 */
  readonly projectsFile: string;
  /** providers.json —— Provider 列表（密钥只存引用，本体在系统密钥库）。写入归 W1.5a。 */
  readonly providersFile: string;
  /** profiles.json —— Agent Profile 列表。 */
  readonly profilesFile: string;
  /** roles.json —— 自定义角色列表（T8.4，§3.1「一段角色提示词 + 一套默认权限」）。 */
  readonly rolesFile: string;
  /** habits/ —— 共享记忆（用户习惯）根目录，一条一文件。 */
  readonly habitsDir: string;
  /** habits/ 下的四分类子目录（workflow / tech / communication / environment）。 */
  readonly habitCategoryDirs: Readonly<Record<HabitCategory, string>>;
  /** observations.json —— 跨会话「纠正观察」记录（来源三累计依据，§8.2.4）。 */
  readonly observationsFile: string;
  /** knowledge/ —— 知识库根目录。 */
  readonly knowledgeDir: string;
  /** knowledge/sources/ —— 导入的原文件（保留导入时的目录结构）。 */
  readonly knowledgeSourcesDir: string;
  /** knowledge/notes/ —— 手动新建与会话收录的条目。 */
  readonly knowledgeNotesDir: string;
  /** index.sqlite —— 习惯 + 知识库索引（可重建）。创建归 W1.3a。 */
  readonly indexDbFile: string;
}

/** 项目数据布局路径记录（设计文档 §10.2）。所有成员由注入的项目根目录派生。 */
export interface ProjectLayout {
  /** 注入的项目根目录。 */
  readonly projectRootDir: string;
  /** <项目根>/.workbench —— 项目数据根。 */
  readonly workbenchDir: string;
  /** project.json —— 项目配置：角色绑定、输出语言覆盖、权限策略。 */
  readonly projectFile: string;
  /** sessions.json —— 会话登记表（Local↔Native Session ID 映射，供原生恢复，§10.2 规则 3）。 */
  readonly sessionsFile: string;
  /**
   * sessions/ —— 对话回放本根目录（T8.2b，§10.2 规则 3 修订版）：
   * `<localSessionId>/transcript.jsonl` + `inflight/`。目录按需创建（首次写入时），
   * 与 sessions.json 一样不在 initProjectLayout 里预建——没聊过的项目不该多出空目录。
   */
  readonly sessionsDir: string;
  /** sessions/inflight/ —— 在飞轮次标记（`<turnId>.json`）与部分文本（`<turnId>.partial.txt`）。 */
  readonly sessionsInflightDir: string;
  /** plans/ —— 计划正文与 meta（plan-v<N>.md / plan-v<N>.meta.json，文件命名归 W1.2b）。 */
  readonly plansDir: string;
  /** tasks/ —— 任务合同 + 状态（task-<id>.json，文件命名归 W1.2b）。 */
  readonly tasksDir: string;
  /** runs/ —— 执行记录（run-<id>/ 子目录，子目录命名归 W1.2b）。 */
  readonly runsDir: string;
  /** memory/ —— 项目记忆根目录。 */
  readonly memoryDir: string;
  /** memory/ 下的三分类目录（decision→decisions、rule→rules、lesson→lessons）。 */
  readonly memoryCategoryDirs: Readonly<Record<MemoryDirCategory, string>>;
  /** memory/candidates/ —— 待审核候选（状态 candidate 的条目，设计文档 §8.1）。 */
  readonly memoryCandidatesDir: string;
  /** memory/state.md —— 当前状态快照（单文件覆盖更新，写入归 W1.2c）。 */
  readonly memoryStateFile: string;
  /** knowledge/ —— 项目归属的知识库条目（可选启用）。 */
  readonly knowledgeDir: string;
  /** index.sqlite —— 本项目检索索引（可重建）。创建归 W1.3a。 */
  readonly indexDbFile: string;
}

/** 解析全局数据布局（纯函数，不触碰文件系统）。 */
export function resolveGlobalLayout(rootDir: string): GlobalLayout {
  const habitsDir = join(rootDir, "habits");
  const knowledgeDir = join(rootDir, "knowledge");
  const habitCategoryDirs = Object.fromEntries(
    HABIT_CATEGORIES.map((category) => [category, join(habitsDir, category)]),
  ) as Record<HabitCategory, string>;
  return {
    rootDir,
    configFile: join(rootDir, "config.json"),
    projectsFile: join(rootDir, "projects.json"),
    providersFile: join(rootDir, "providers.json"),
    profilesFile: join(rootDir, "profiles.json"),
    rolesFile: join(rootDir, "roles.json"),
    habitsDir,
    habitCategoryDirs,
    observationsFile: join(rootDir, "observations.json"),
    knowledgeDir,
    knowledgeSourcesDir: join(knowledgeDir, "sources"),
    knowledgeNotesDir: join(knowledgeDir, "notes"),
    indexDbFile: join(rootDir, "index.sqlite"),
  };
}

/** 解析项目数据布局（纯函数，不触碰文件系统）。入参为项目根目录，.workbench 由本函数派生。 */
export function resolveProjectLayout(projectRootDir: string): ProjectLayout {
  const workbenchDir = join(projectRootDir, WORKBENCH_DIR_NAME);
  const memoryDir = join(workbenchDir, "memory");
  const sessionsDir = join(workbenchDir, "sessions");
  const memoryCategoryDirs = Object.fromEntries(
    Object.entries(MEMORY_DIR_NAMES).map(([category, dirName]) => [
      category,
      join(memoryDir, dirName),
    ]),
  ) as Record<MemoryDirCategory, string>;
  return {
    projectRootDir,
    workbenchDir,
    projectFile: join(workbenchDir, "project.json"),
    sessionsFile: join(workbenchDir, "sessions.json"),
    sessionsDir,
    sessionsInflightDir: join(sessionsDir, "inflight"),
    plansDir: join(workbenchDir, "plans"),
    tasksDir: join(workbenchDir, "tasks"),
    runsDir: join(workbenchDir, "runs"),
    memoryDir,
    memoryCategoryDirs,
    memoryCandidatesDir: join(memoryDir, "candidates"),
    memoryStateFile: join(memoryDir, "state.md"),
    knowledgeDir: join(workbenchDir, "knowledge"),
    indexDbFile: join(workbenchDir, "index.sqlite"),
  };
}

/**
 * 初始化全局数据布局：幂等补建全部目录（已存在即跳过，已有内容不受影响），
 * 不创建任何文件（见模块注释）。返回布局记录供调用方直接使用。
 */
export async function initGlobalLayout(rootDir: string): Promise<GlobalLayout> {
  const layout = resolveGlobalLayout(rootDir);
  const dirs = [
    layout.rootDir,
    layout.habitsDir,
    ...Object.values(layout.habitCategoryDirs),
    layout.knowledgeDir,
    layout.knowledgeSourcesDir,
    layout.knowledgeNotesDir,
  ];
  for (const dir of dirs) {
    await ensureDir(dir);
  }
  return layout;
}

/**
 * 初始化项目数据布局：幂等补建 .workbench 下全部目录（已存在即跳过，
 * 已有内容不受影响），不创建任何文件（见模块注释）。返回布局记录供调用方直接使用。
 */
export async function initProjectLayout(projectRootDir: string): Promise<ProjectLayout> {
  const layout = resolveProjectLayout(projectRootDir);
  const dirs = [
    layout.workbenchDir,
    layout.plansDir,
    layout.tasksDir,
    layout.runsDir,
    layout.memoryDir,
    ...Object.values(layout.memoryCategoryDirs),
    layout.memoryCandidatesDir,
    layout.knowledgeDir,
  ];
  for (const dir of dirs) {
    await ensureDir(dir);
  }
  return layout;
}
