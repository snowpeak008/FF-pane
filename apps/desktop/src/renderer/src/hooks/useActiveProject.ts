/**
 * 当前项目上下文（W3.4b 前置）：把 ui store 的 activeProjectId 解析为完整登记条目。
 *
 * 项目级页面（会话/计划/任务/执行记录/记忆）都以「当前项目」为作用域：拿到 entry.rootPath
 * 才能向主进程发起项目级查询（IPC 通道一律携带 projectRoot）。未选项目时返回 null，
 * 页面显示「先选个项目」空态。服务端项目数据不进 store（stores 约定），故在此经 IPC 查询解析。
 */

import type { ProjectRegistryEntry } from "@ff-pane/shared";
import { queryData } from "../ipc/query";
import { useInvokeQuery } from "../ipc/useInvokeQuery";
import { useUiStore } from "../stores/ui";

export interface ActiveProjectResult {
  /** 当前项目登记条目；未选 / 已失效返回 null。 */
  readonly entry: ProjectRegistryEntry | null;
  /** 项目列表首次加载中（用于区分「加载中」与「确实没选」）。 */
  readonly loading: boolean;
}

/** 解析当前项目（activeProjectId → 完整条目）。 */
export function useActiveProject(): ActiveProjectResult {
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const { state } = useInvokeQuery("projects:list");
  const list = queryData(state) ?? [];
  const entry =
    activeProjectId === null ? null : (list.find((p) => p.id === activeProjectId) ?? null);
  return { entry, loading: state.status === "loading" };
}
