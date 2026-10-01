/**
 * 同一窗口的启动去重。进行中的第二次调用复用第一次的 Promise，避免连启两个 PTY。
 */

export function createWindowLaunchGate(): {
  run<T>(windowId: string, fn: () => Promise<T>): Promise<T>;
} {
  const inflight = new Map<string, Promise<unknown>>();
  return {
    run<T>(windowId: string, fn: () => Promise<T>): Promise<T> {
      const existing = inflight.get(windowId);
      if (existing !== undefined) {
        return existing as Promise<T>;
      }
      const promise = fn().finally(() => {
        if (inflight.get(windowId) === promise) {
          inflight.delete(windowId);
        }
      });
      inflight.set(windowId, promise);
      return promise;
    },
  };
}
