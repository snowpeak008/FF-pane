/**
 * 一次性查询的统一状态形态（W3.1c）——三态组件（设计系统 §6.2）只认这一个形状。
 *
 * 状态机（四态 + 两个"忙"标志）：
 *
 *   idle ──start──▶ loading ──settle──▶ success / error
 *                     ▲                    │
 *                     └────────reset───────┘
 *
 *   success ──start──▶ success{refreshing:true}   （已有数据的刷新）
 *   error   ──start──▶ error{retrying:true}       （错误态点重试）
 *
 * 为什么刷新不回到 loading：设计系统 §5.8 明确"已有数据的刷新不得把内容换成骨架"，
 * 骨架屏只在 status === "loading"（首次加载）时出现；refreshing / retrying 对应
 * 行内进度或按钮 loading。判定请用 shouldShowSkeleton() / isQueryBusy()，
 * 不要在页面里自己比较字符串。
 *
 * 约定（对页面工单）：
 * - invokeQuery 永不 reject，失败一律落成 status === "error"，错误原文在 error.message；
 * - 服务端数据不进 store 长存（见 stores/index.ts 的约定），查询结果留在组件本地状态；
 * - 请求失败必须走错误态，不得显示空态（§6.2「区分空与错」）。
 *
 * 本文件不依赖 DOM / React，可直接单测。
 */
import type { InvokeChannel, InvokeRequest, InvokeResponse } from "../../../shared-ipc/contracts";
import { getIpcApi } from "./api";
import { type IpcErrorInfo, toIpcErrorInfo } from "./errors";

export type QueryStatus = "idle" | "loading" | "success" | "error";

/** 查询状态：三态组件按 status 分支渲染骨架 / 空态（由数据自身判定）/ 错误态。 */
export type QueryState<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly data: T; readonly refreshing: boolean }
  | { readonly status: "error"; readonly error: IpcErrorInfo; readonly retrying: boolean };

/** 已结算的状态（invokeQuery 的返回值只可能是这两种）。 */
export type SettledQueryState<T> = Extract<QueryState<T>, { readonly status: "success" | "error" }>;

export const IDLE_QUERY_STATE = { status: "idle" } as const satisfies QueryState<never>;
export const LOADING_QUERY_STATE = { status: "loading" } as const satisfies QueryState<never>;

export function successQueryState<T>(data: T, refreshing = false): SettledQueryState<T> {
  return { status: "success", data, refreshing };
}

export function errorQueryState(error: IpcErrorInfo, retrying = false): SettledQueryState<never> {
  return { status: "error", error, retrying };
}

/** 首次加载：唯一允许出骨架屏的状态（设计系统 §5.8）。 */
export function shouldShowSkeleton(state: QueryState<unknown>): boolean {
  return state.status === "loading";
}

/** 是否有请求在飞（首次加载、刷新、重试都算），用于禁用重复触发的控件。 */
export function isQueryBusy(state: QueryState<unknown>): boolean {
  if (state.status === "loading") {
    return true;
  }
  if (state.status === "success") {
    return state.refreshing;
  }
  if (state.status === "error") {
    return state.retrying;
  }
  return false;
}

/** 取已有数据（刷新期间仍然返回旧数据，保证内容不闪）。 */
export function queryData<T>(state: QueryState<T>): T | undefined {
  return state.status === "success" ? state.data : undefined;
}

/** 取错误信息（非错误态返回 undefined）。 */
export function queryError(state: QueryState<unknown>): IpcErrorInfo | undefined {
  return state.status === "error" ? state.error : undefined;
}

export type QueryAction<T> =
  | { readonly type: "start" }
  | { readonly type: "settle"; readonly state: SettledQueryState<T> }
  | { readonly type: "reset" };

/** 纯 reducer：hook 与单测共用同一套迁移规则。 */
export function queryReducer<T>(state: QueryState<T>, action: QueryAction<T>): QueryState<T> {
  switch (action.type) {
    case "start": {
      if (state.status === "success") {
        return { ...state, refreshing: true };
      }
      if (state.status === "error") {
        return { ...state, retrying: true };
      }
      return LOADING_QUERY_STATE;
    }
    case "settle": {
      return action.state;
    }
    case "reset": {
      return IDLE_QUERY_STATE;
    }
  }
}

/** 无请求体的通道不传参数，有请求体的通道强制传参（与 shared-ipc/client 同构）。 */
export type InvokeQueryArgs<K extends InvokeChannel> =
  InvokeRequest<K> extends undefined ? [] : [request: InvokeRequest<K>];

/**
 * 一次性查询：调用契约内的 invoke 通道，**永不 reject**，
 * 成功/失败统一落成 SettledQueryState 供三态组件消费。
 */
export async function invokeQuery<K extends InvokeChannel>(
  channel: K,
  ...args: InvokeQueryArgs<K>
): Promise<SettledQueryState<InvokeResponse<K>>> {
  try {
    const data = await getIpcApi().invoke(channel, ...args);
    return successQueryState(data);
  } catch (thrown) {
    return errorQueryState(toIpcErrorInfo(thrown, channel));
  }
}
