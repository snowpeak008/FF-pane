/**
 * IPC 数据层出口（W3.1c）—— 渲染层与主进程通信的唯一通道，页面工单只从这里导入。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 页面工单速查手册
 * ────────────────────────────────────────────────────────────────────────────
 * 一次性查询（列表、详情、设置读取…）：
 *
 *   const { state, refetch } = useInvokeQuery("app:get-info");
 *   if (shouldShowSkeleton(state)) return <ListSkeleton />;          // 仅首次加载出骨架
 *   if (state.status === "error") return <ErrorBlock error={state.error} onRetry={refetch} />;
 *   if (state.status === "success") return <List data={state.data} busy={state.refreshing} />;
 *
 * 命令式查询（事件回调里、初始化流程里）：
 *
 *   const settled = await invokeQuery("app:ping", { message: "hi", sentAt: Date.now() });
 *   //  ↑ 永不 reject；settled.status 只可能是 "success" | "error"
 *
 * 事件订阅（主进程推送）：
 *
 *   useSubscription("smoke:event", (payload) => { ... });   // 卸载自动清理
 *
 * 错误处理：一律用 IpcErrorInfo 的 code / message / path 字段，
 * **不要** 写 `err instanceof XxxError`——跨 IPC 后原型链已经丢失（见 errors.ts 头注）。
 *
 * 新增通道：先在 src/shared-ipc/contracts.ts 登记（漏登记编译失败），
 * 再照 app-info.ts 的模板在本目录加一个查询模块。
 *
 * 与 store 的边界（见 stores/index.ts）：服务端数据不进 store 长存，
 * 查询结果留在组件本地状态；只有订阅推送的增量才允许进 store 当订阅缓存。
 * ────────────────────────────────────────────────────────────────────────────
 */
export { getIpcApi, hasIpcApi } from "./api";
export { fetchAppInfo, useAppInfo } from "./app-info";
export {
  describeIpcError,
  type IpcErrorInfo,
  isIpcErrorInfo,
  toIpcErrorInfo,
  UNKNOWN_IPC_ERROR_CODE,
  UNKNOWN_IPC_ERROR_MESSAGE,
} from "./errors";
export {
  errorQueryState,
  IDLE_QUERY_STATE,
  type InvokeQueryArgs,
  invokeQuery,
  isQueryBusy,
  LOADING_QUERY_STATE,
  type QueryAction,
  type QueryState,
  type QueryStatus,
  queryData,
  queryError,
  queryReducer,
  type SettledQueryState,
  shouldShowSkeleton,
  successQueryState,
} from "./query";
export { bindSubscription, type SubscriptionBinding } from "./subscription";
export { type QueryResult, useInvokeQuery } from "./useInvokeQuery";
export { useSubscription } from "./useSubscription";
