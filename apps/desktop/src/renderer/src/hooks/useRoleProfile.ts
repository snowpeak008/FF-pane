/**
 * 按角色解析可用 Profile（T4.2）。
 *
 * M1 简化：取第一个 defaultRole 匹配的 Profile。项目级角色绑定（project.json 的
 * Role → ProfileId）尚未经 IPC 暴露，接通后此处改为读绑定（见 docs/开发进度.md）。
 */

import type { AgentProfile, Role } from "@ff-pane/shared";
import { isCustomRoleId } from "@ff-pane/shared";
import { queryData } from "../ipc/query";
import { useInvokeQuery } from "../ipc/useInvokeQuery";

export interface RoleProfileResult {
  /** 该角色可用的 Profile（无匹配为 null）。 */
  readonly profile: AgentProfile | null;
  readonly loading: boolean;
}

export function useRoleProfile(role: Role): RoleProfileResult {
  const { state } = useInvokeQuery("profiles:list");
  const list = queryData(state) ?? [];
  const profile = list.find((p) => p.defaultRole === role) ?? null;
  return { profile, loading: state.status === "loading" };
}

export interface DiscussionProfilesResult {
  /** 可承载讨论轮的 Profile：defaultRole 为 planner 或自定义角色（T8.4），列表序。 */
  readonly profiles: readonly AgentProfile[];
  readonly loading: boolean;
}

/**
 * 讨论轮可选的 Profile 列表（T8.4）：内置 planner 与绑定自定义角色的 Profile 都能
 * 承载 planner-message 轮（编排器按 defaultRole 解析第 1 层与信封）；Worker / Reviewer
 * Profile 走任务派发管线，不进本列表。
 */
export function useDiscussionProfiles(): DiscussionProfilesResult {
  const { state } = useInvokeQuery("profiles:list");
  const list = queryData(state) ?? [];
  const profiles = list.filter((p) => p.defaultRole === "planner" || isCustomRoleId(p.defaultRole));
  return { profiles, loading: state.status === "loading" };
}
