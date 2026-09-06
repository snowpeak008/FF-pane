/**
 * cli_login 登录态探测的渲染层缓存（T9.2 ②）——纯逻辑，无 React 依赖，可直接单测。
 *
 * 为什么要有这一层：探测会真的 spawn CLI（Node 系 CLI 冷启动秒级），编辑器里
 * 切换类型 / 重开对话框都会触发展示——不做缓存与在飞去重，一次编辑流程能把同一个
 * CLI 拉起七八遍。策略：
 * - **结果缓存 TTL 30s**：登录态不是毫秒级变化的东西，30s 内复用；
 * - **在飞去重**：同 runtime 的并发探测共享同一个 promise；
 * - **手动刷新旁路**：用户点「刷新」时绕过缓存强制重探（forceRefresh）。
 */

import type { CliLoginProbeView, CliLoginRuntimeWire } from "../../../../../shared-ipc/contracts";

/** 缓存 TTL（毫秒）。 */
export const CLI_LOGIN_PROBE_TTL_MS = 30_000;

interface CacheEntry {
  readonly at: number;
  readonly result: CliLoginProbeView;
}

/** 探测执行函数（生产 = invokeQuery 包装；测试注入假实现）。 */
export type ProbeRunner = (runtime: CliLoginRuntimeWire) => Promise<CliLoginProbeView>;

export interface CliLoginProbeCache {
  /** 取登录态：缓存新鲜即复用，在飞即共享，否则发起探测。 */
  probe(runtime: CliLoginRuntimeWire, force?: boolean): Promise<CliLoginProbeView>;
  /** 清空缓存（测试用）。 */
  clear(): void;
}

/** 构造探测缓存（模块级单例见下方 export；测试自建实例注入假 runner 与时钟）。 */
export function createCliLoginProbeCache(
  runner: ProbeRunner,
  now: () => number = Date.now,
  ttlMs: number = CLI_LOGIN_PROBE_TTL_MS,
): CliLoginProbeCache {
  const cache = new Map<CliLoginRuntimeWire, CacheEntry>();
  const inflight = new Map<CliLoginRuntimeWire, Promise<CliLoginProbeView>>();

  return {
    async probe(runtime, force = false) {
      if (!force) {
        const hit = cache.get(runtime);
        if (hit !== undefined && now() - hit.at < ttlMs) {
          return hit.result;
        }
        const pending = inflight.get(runtime);
        if (pending !== undefined) {
          return pending;
        }
      }
      const promise = runner(runtime)
        .then((result) => {
          cache.set(runtime, { at: now(), result });
          return result;
        })
        .finally(() => {
          inflight.delete(runtime);
        });
      inflight.set(runtime, promise);
      return promise;
    },
    clear() {
      cache.clear();
      inflight.clear();
    },
  };
}
