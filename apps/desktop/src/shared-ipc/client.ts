/**
 * 渲染侧 IPC 客户端工厂：把 ipcRenderer 形状的传输层包装为契约类型化 API。
 * 传输层经结构化接口注入 —— 纯逻辑可用假对象单测；preload 中注入真实 ipcRenderer。
 */
import {
  EVENT_CHANNELS,
  type EventChannel,
  type EventPayload,
  INVOKE_CHANNELS,
  type InvokeChannel,
  type InvokeRequest,
  type InvokeResponse,
} from "./contracts";
import { unwrapIpcResult } from "./envelope";

/** ipcRenderer 的最小结构化形状（避免 shared-ipc 依赖 electron 类型）。 */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (...args: unknown[]) => void): unknown;
}

/** 无请求体的通道调用时不传参数，有请求体的通道强制要求参数。 */
type InvokeArgs<K extends InvokeChannel> =
  InvokeRequest<K> extends undefined ? [] : [request: InvokeRequest<K>];

/** preload 经 contextBridge 暴露给渲染进程的唯一受控 API 形状。 */
export interface FfPaneIpcApi {
  /** 请求/响应模式：调用契约内的 invoke 通道，错误信封还原为 IpcInvokeError 抛出。 */
  invoke<K extends InvokeChannel>(channel: K, ...args: InvokeArgs<K>): Promise<InvokeResponse<K>>;
  /**
   * 请求/响应模式的信封原样版（T9.2 ①）：返回未解包的 IpcResult，由渲染层自行
   * unwrapIpcResult。存在的理由是 contextBridge 的错误复制只保留 Error.message
   * （Electron 文档明示）——invoke 在 preload 世界里抛出的 IpcInvokeError 过桥后
   * code / field / violations 全部被剥掉，报错人话化的结构化字段只能以**值**的
   * 形态过桥（值走结构化克隆，字段齐全）。渲染层 invokeQuery 恒走本方法；
   * invoke 保持既有形状不变（E2E / live 脚本直连 window.ffpane 的消费面不动）。
   * 可选：单测的假 window.ffpane 只实现 invoke 时，invokeQuery 回退走 invoke。
   */
  invokeEnvelope?<K extends InvokeChannel>(channel: K, ...args: InvokeArgs<K>): Promise<unknown>;
  /** 事件订阅模式：订阅契约内的推送通道，返回取消订阅函数。 */
  subscribe<K extends EventChannel>(
    channel: K,
    listener: (payload: EventPayload<K>) => void,
  ): () => void;
}

const INVOKE_CHANNEL_SET: ReadonlySet<string> = new Set(INVOKE_CHANNELS);
const EVENT_CHANNEL_SET: ReadonlySet<string> = new Set(EVENT_CHANNELS);

export function createIpcClient(transport: IpcRendererLike): FfPaneIpcApi {
  return {
    async invoke(channel, ...args) {
      if (!INVOKE_CHANNEL_SET.has(channel)) {
        throw new Error(`IPC invoke 通道未在契约中登记：${String(channel)}`);
      }
      const raw = await transport.invoke(channel, args[0]);
      return unwrapIpcResult(raw, channel);
    },
    async invokeEnvelope(channel, ...args) {
      if (!INVOKE_CHANNEL_SET.has(channel)) {
        throw new Error(`IPC invoke 通道未在契约中登记：${String(channel)}`);
      }
      // 不解包：信封是纯数据，过 contextBridge 走结构化克隆、结构化字段无损；
      // 解包（抛 IpcInvokeError）留给渲染层世界做（ipc/query.ts）。
      return transport.invoke(channel, args[0]);
    },
    subscribe(channel, listener) {
      if (!EVENT_CHANNEL_SET.has(channel)) {
        throw new Error(`IPC 事件通道未在契约中登记：${String(channel)}`);
      }
      // ipcRenderer 事件回调的第 1 个参数是 IpcRendererEvent，第 2 个才是载荷
      const wrapped = (...eventArgs: unknown[]): void => {
        listener(eventArgs[1] as EventPayload<typeof channel>);
      };
      transport.on(channel, wrapped);
      return () => {
        transport.removeListener(channel, wrapped);
      };
    },
  };
}
