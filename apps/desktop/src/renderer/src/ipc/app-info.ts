/**
 * app:get-info 的端到端参考实现（W3.1c）——页面工单照这个模板加自己的查询。
 *
 * 三步（本工单不新增业务通道，通道由各页面工单自行在 shared-ipc/contracts.ts 登记）：
 *   1. 在 src/shared-ipc/contracts.ts 的 IpcInvokeContracts 里登记通道与请求/响应类型，
 *      并加进 INVOKE_CHANNELS 运行时清单（漏登记编译期就失败）；
 *   2. 在本目录新增一个「查询模块」，导出 fetchXxx()（命令式）与 useXxx()（组件用）；
 *   3. 组件按 QueryState 的四态渲染骨架 / 空态 / 错误态（设计系统 §6.2）。
 *
 * 命名约定：fetchXxx 返回已结算状态（永不 reject），useXxx 返回 { state, refetch }。
 */
import type { AppInfo } from "../../../shared-ipc/contracts";
import type { SettledQueryState } from "./query";
import { invokeQuery } from "./query";
import { type QueryResult, useInvokeQuery } from "./useInvokeQuery";

/** 命令式查询：事件回调、初始化流程里用。 */
export function fetchAppInfo(): Promise<SettledQueryState<AppInfo>> {
  return invokeQuery("app:get-info");
}

/** 组件用查询：挂载即拉取，失败可 refetch 重试。 */
export function useAppInfo(): QueryResult<AppInfo> {
  return useInvokeQuery("app:get-info");
}
