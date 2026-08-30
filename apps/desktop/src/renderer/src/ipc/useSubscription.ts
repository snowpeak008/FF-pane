/**
 * useSubscription —— 事件订阅 hook（W3.1c），卸载自动清理。
 *
 * 语义见 subscription.ts：只订阅一次、解绑幂等、迟到事件丢弃。
 * 监听器不进依赖数组：每次渲染传入新的箭头函数也不会重建订阅，
 * 因此页面工单不需要为回调套 useCallback。
 */
import { useEffect, useRef } from "react";
import type { EventChannel, EventPayload } from "../../../shared-ipc/contracts";
import { getIpcApi } from "./api";
import { bindSubscription } from "./subscription";

export function useSubscription<K extends EventChannel>(
  channel: K,
  listener: (payload: EventPayload<K>) => void,
): void {
  const listenerRef = useRef(listener);
  // 渲染期同步最新回调：订阅建立后的事件必须打到最新监听器上，
  // 放到 effect 里同步会在"渲染完成到 effect 执行"之间留下调用旧回调的窗口。
  listenerRef.current = listener;

  useEffect(() => {
    const binding = bindSubscription(getIpcApi(), channel, () => listenerRef.current);
    return () => {
      binding.unsubscribe();
    };
  }, [channel]);
}
