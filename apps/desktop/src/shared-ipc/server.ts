/**
 * 主进程侧 IPC 装配：把契约类型化的 handler 表注册到 ipcMain 形状的对象上，
 * 并把返回值/异常统一包装为 IpcResult 信封（renderer 侧由 client.ts 解包）。
 * ipcMain / webContents 经结构化接口注入 —— 纯逻辑可用假对象单测。
 */
import {
  type EventChannel,
  type EventPayload,
  type InvokeChannel,
  type InvokeRequest,
  type InvokeResponse,
  isValidChannelName,
} from "./contracts";
import { errResult, type IpcResult, okResult } from "./envelope";

/** ipcMain 的最小结构化形状。 */
export interface IpcMainLike {
  handle(
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown,
  ): void;
}

/** 契约内全部 invoke 通道的 handler 表类型。 */
export type InvokeHandlers = {
  [K in InvokeChannel]: (
    request: InvokeRequest<K>,
  ) => Promise<InvokeResponse<K>> | InvokeResponse<K>;
};

/** 注册一组 invoke handler；通道名不符合命名规范时装配期立即抛错。 */
export function registerInvokeHandlers<K extends InvokeChannel>(
  ipcMain: IpcMainLike,
  handlers: Pick<InvokeHandlers, K>,
): void {
  for (const channel of Object.keys(handlers) as K[]) {
    if (!isValidChannelName(channel)) {
      throw new Error(`IPC 通道名不符合 <域>:<动作> 规范：${channel}`);
    }
    // K 为联合类型时 handlers[channel] 的调用签名无法收窄，此处以宽签名调用；
    // 对外 API 的类型约束已保证 request/response 与契约一致。
    const handler = handlers[channel] as (request: unknown) => Promise<unknown> | unknown;
    ipcMain.handle(channel, async (_event, request): Promise<IpcResult<unknown>> => {
      try {
        return okResult(await handler(request));
      } catch (thrown) {
        return errResult(channel, thrown);
      }
    });
  }
}

/** webContents 的最小结构化形状。 */
export interface WebContentsLike {
  send(channel: string, ...args: unknown[]): void;
}

/** 类型化事件发布：向指定 webContents 推送契约内的事件。 */
export function publishEvent<K extends EventChannel>(
  target: WebContentsLike,
  channel: K,
  payload: EventPayload<K>,
): void {
  target.send(channel, payload);
}
