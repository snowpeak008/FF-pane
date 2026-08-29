/**
 * IPC 通道契约 —— 主进程与渲染进程之间通信的唯一事实来源。
 *
 * 三种通信模式：
 * 1. invoke（请求/响应）：renderer → main 异步一问一答，见 IpcInvokeContracts
 * 2. event（事件订阅）：main → renderer 单向推送，见 IpcEventContracts
 * 3. 冒烟自测通道（smoke:*）仅在 --smoke 模式下由主进程注册
 *
 * 通道命名规则：<域>:<动作>，全小写 kebab-case（CHANNEL_NAME_PATTERN）。
 * 本文件为纯类型与常量，禁止 import 任何 Electron / Node API。
 */

/** 应用元信息（app:get-info 响应）。 */
export interface AppInfo {
  readonly name: string;
  readonly version: string;
  readonly runtime: {
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
  };
}

/** app:get-locale 响应：主进程 app.getLocale() 检测到的系统语言（BCP 47，如 zh-CN）。 */
export interface LocaleInfo {
  readonly locale: string;
}

/** app:ping 请求。 */
export interface PingRequest {
  readonly message: string;
  readonly sentAt: number;
}

/** app:ping 响应。 */
export interface PingResponse {
  readonly reply: "pong";
  readonly echoed: string;
  readonly repliedAt: number;
}

/** diagnostics:check-sqlite 响应（失败路径经由 IpcResult 错误信封传递）。 */
export interface SqliteCheckReport {
  readonly sqliteVersion: string;
  readonly checkedAt: number;
}

/** 冒烟自测中单个检查项的结果。 */
export interface SmokeCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** smoke:report 请求：renderer 汇总的全部检查结果。 */
export interface SmokeReport {
  readonly checks: readonly SmokeCheck[];
}

/** invoke（请求/响应）通道契约表。 */
export interface IpcInvokeContracts {
  "app:get-info": { request: undefined; response: AppInfo };
  /** 系统语言检测（Electron 下 navigator.language 不可靠，统一走主进程）。 */
  "app:get-locale": { request: undefined; response: LocaleInfo };
  "app:ping": { request: PingRequest; response: PingResponse };
  "diagnostics:check-sqlite": { request: undefined; response: SqliteCheckReport };
  /** 仅冒烟模式注册：请求主进程向本窗口推送一条 smoke:event。 */
  "smoke:emit-event": { request: { readonly seq: number }; response: { readonly emitted: true } };
  /** 仅冒烟模式注册：上报渲染层检查结果，主进程据此决定退出码。 */
  "smoke:report": { request: SmokeReport; response: { readonly acknowledged: true } };
}

/** 事件（main → renderer 推送）通道契约表。 */
export interface IpcEventContracts {
  /** 仅冒烟模式使用：验证订阅链路的回声事件。 */
  "smoke:event": { payload: { readonly seq: number; readonly emittedAt: number } };
}

export type InvokeChannel = keyof IpcInvokeContracts;
export type InvokeRequest<K extends InvokeChannel> = IpcInvokeContracts[K]["request"];
export type InvokeResponse<K extends InvokeChannel> = IpcInvokeContracts[K]["response"];

export type EventChannel = keyof IpcEventContracts;
export type EventPayload<K extends EventChannel> = IpcEventContracts[K]["payload"];

/** 通道命名规则：<域>:<动作>，全小写 kebab-case。 */
export const CHANNEL_NAME_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

export function isValidChannelName(name: string): boolean {
  return CHANNEL_NAME_PATTERN.test(name);
}

/** invoke 通道运行时允许清单（preload 据此拦截契约之外的通道调用）。 */
export const INVOKE_CHANNELS = [
  "app:get-info",
  "app:get-locale",
  "app:ping",
  "diagnostics:check-sqlite",
  "smoke:emit-event",
  "smoke:report",
] as const satisfies readonly InvokeChannel[];

/** 事件通道运行时允许清单。 */
export const EVENT_CHANNELS = ["smoke:event"] as const satisfies readonly EventChannel[];

type AssertNever<T extends never> = T;

/** 编译期完整性断言：契约表新增通道而未登记到运行时清单时，此处实例化失败报错。 */
export type _AssertInvokeChannelsComplete = AssertNever<
  Exclude<InvokeChannel, (typeof INVOKE_CHANNELS)[number]>
>;
/** 编译期完整性断言：事件契约与运行时清单保持一致。 */
export type _AssertEventChannelsComplete = AssertNever<
  Exclude<EventChannel, (typeof EVENT_CHANNELS)[number]>
>;
