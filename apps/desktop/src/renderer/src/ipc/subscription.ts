/**
 * 事件订阅的纯逻辑内核（W3.1c）——useSubscription 与单测共用同一套清理语义。
 *
 * 三条语义（页面工单可以依赖）：
 * 1. **只订阅一次**：回调身份变化（每次渲染新建的箭头函数）不会重建订阅——
 *    监听器经 getListener() 间接取用，取的永远是最新那个。
 * 2. **解绑幂等**：unsubscribe() 多次调用只向传输层解绑一次。
 * 3. **迟到事件一律丢弃**：解绑之后到达的事件不会再触碰监听器
 *    （React 卸载后 setState 会告警；主进程推送与解绑之间天然存在竞态窗口）。
 *
 * 本文件不依赖 DOM / React，可直接用假 window.ffpane 单测。
 */
import type { FfPaneIpcApi } from "../../../shared-ipc/client";
import type { EventChannel, EventPayload } from "../../../shared-ipc/contracts";

export interface SubscriptionBinding {
  /** 幂等解绑。 */
  readonly unsubscribe: () => void;
  /** 是否仍在派发事件（解绑后恒为 false）。 */
  readonly isActive: () => boolean;
}

/**
 * 绑定一个事件通道。
 * @param api 受控 IPC API（生产传 getIpcApi()，单测传假对象）
 * @param channel 契约内的事件通道
 * @param getListener 取当前监听器的间接层（hook 里指向 ref.current）
 */
export function bindSubscription<K extends EventChannel>(
  api: FfPaneIpcApi,
  channel: K,
  getListener: () => (payload: EventPayload<K>) => void,
): SubscriptionBinding {
  let active = true;
  let released = false;

  const release = api.subscribe(channel, (payload) => {
    if (!active) {
      return;
    }
    getListener()(payload);
  });

  return {
    unsubscribe: () => {
      if (released) {
        return;
      }
      released = true;
      active = false;
      release();
    },
    isActive: () => active,
  };
}
