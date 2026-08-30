/**
 * 三态标准组件（设计系统 §6.2 / 开发计划 §1.5 第 2 条）出口。
 *
 * 每个数据视图三态齐全是硬性验收项：
 *   加载中 → LoadingState（首次加载）/ InlineLoading（已有数据的刷新）
 *   空     → EmptyState（一句话 + 至多一个主操作）
 *   出错   → ErrorState（错误原文 + 概括 + 重试）
 * 请求失败必须走 ErrorState，退化成 EmptyState 按 bug 对待。
 */
export { EmptyState, type EmptyStateAction, type EmptyStateProps } from "./EmptyState";
export { ErrorState, type ErrorStateAction, type ErrorStateProps } from "./ErrorState";
export { formatErrorDetail, hasErrorDetail, summarizeError } from "./error-text";
export {
  InlineLoading,
  type InlineLoadingProps,
  LoadingState,
  type LoadingStateProps,
  type LoadingVariant,
} from "./LoadingState";
