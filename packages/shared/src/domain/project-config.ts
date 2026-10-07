/**
 * 项目配置：一张表里 Claude、Codex、Grok、DeepSeek 各一路。
 * 项目可绑定一张配置；没绑定时用标记为默认的那张。
 * 可用项目范围缺省或空数组 = 所有项目。
 */

import type { ProjectConfigId, ProjectId, ProviderId } from "./common.js";
import type { ConnectionMode, ReasoningEffortLevel } from "./profile.js";
import type { WorkbenchAiKind } from "./workbench.js";
import type { WorkbenchPermissionLevel } from "./workbench-permission.js";

/** 配置里的一路：本机登录或中转。模型与思考强度可空（空 = 用 CLI 自己的默认）。 */
export interface ProjectConfigRoute {
  readonly connectionMode: ConnectionMode;
  /** 中转时必填。本机登录不保存来源。 */
  readonly providerId?: ProviderId;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffortLevel;
}

/**
 * 全局 configs.json 里的一条配置。
 * 可以只配其中一路。
 */
export interface ProjectConfig {
  readonly id: ProjectConfigId;
  readonly name: string;
  readonly isDefault: boolean;
  /** 缺省或空 = 所有项目可用。 */
  readonly projectIds?: readonly ProjectId[];
  /** 新开窗口对话框的权限初始值。缺省则用全局工作台默认权限。 */
  readonly defaultPermission?: WorkbenchPermissionLevel;
  readonly claude?: ProjectConfigRoute;
  readonly codex?: ProjectConfigRoute;
  readonly grok?: ProjectConfigRoute;
  readonly deepseek?: ProjectConfigRoute;
}

/** 创建 / 更新时提交的内容（id 由存储层生成）。 */
export type ProjectConfigDraft = Omit<ProjectConfig, "id">;

/** 范围是否对所有项目开放。 */
export function isProjectConfigScopeOpen(projectIds: readonly string[] | undefined): boolean {
  return projectIds === undefined || projectIds.length === 0;
}

/** 这张配置能否被该项目看到、绑定、用来开窗口。 */
export function isProjectConfigVisibleTo(
  config: { readonly projectIds?: readonly string[] },
  projectId: string,
): boolean {
  return (
    isProjectConfigScopeOpen(config.projectIds) || (config.projectIds?.includes(projectId) ?? false)
  );
}

/**
 * 开窗口用的配置：项目绑定且仍在范围内 → 那张；否则默认配置。
 * 默认配置永远对所有项目开放，回落时不看它自己的 projectIds。
 * 绑定的配置没有某一路时，不改去用默认配置的那一路。
 */
export function selectEffectiveProjectConfig<
  T extends {
    readonly id: string;
    readonly isDefault: boolean;
    readonly projectIds?: readonly string[];
  },
>(configs: readonly T[], boundId: string | undefined, projectId: string): T | undefined {
  if (boundId !== undefined && boundId.trim() !== "") {
    const bound = configs.find((item) => item.id === boundId);
    if (bound !== undefined && isProjectConfigVisibleTo(bound, projectId)) {
      return bound;
    }
  }
  return configs.find((item) => item.isDefault);
}

/** 这一路。没配返回 undefined。 */
export function projectConfigRoute(
  config: {
    readonly claude?: ProjectConfigRoute;
    readonly codex?: ProjectConfigRoute;
    readonly grok?: ProjectConfigRoute;
    readonly deepseek?: ProjectConfigRoute;
  },
  kind: WorkbenchAiKind,
): ProjectConfigRoute | undefined {
  if (kind === "claude") {
    return config.claude;
  }
  if (kind === "codex") {
    return config.codex;
  }
  if (kind === "grok") {
    return config.grok;
  }
  return config.deepseek;
}

/**
 * 收窄范围时，已经绑着这张配置、但不在新名单里的项目。
 * 范围开放时返回空。
 */
export function projectNamesOutsideScope(
  bound: readonly { readonly id: string; readonly name: string }[],
  projectIds: readonly string[] | undefined,
): readonly string[] {
  if (isProjectConfigScopeOpen(projectIds)) {
    return [];
  }
  const allowed = new Set(projectIds);
  return bound.filter((item) => !allowed.has(item.id)).map((item) => item.name);
}
