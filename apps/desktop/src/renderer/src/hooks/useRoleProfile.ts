/**
 * 按角色解析可用 Profile（T4.2）。
 *
 * M1 简化：取第一个 defaultRole 匹配的 Profile。项目级角色绑定（project.json 的
 * Role → ProfileId）尚未经 IPC 暴露，接通后此处改为读绑定（见 docs/开发进度.md）。
 */

import type { AgentProfile, Role } from "@ff-pane/shared";
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
