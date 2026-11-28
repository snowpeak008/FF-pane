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

import type {
  CliLoginProbeView,
  CliLoginRuntimeWire,
  CursorAccountStatus,
  GeminiAccountStatus,
} from "../../../../../shared-ipc/contracts";

/**
 * 能探登录态的来源：adapters 的 CLI，加上工作台独立登录的 Cursor（cursor:status）
 * 和 Gemini 的 agy（gemini:status）。
 */
export type LoginProbeRuntime = CliLoginRuntimeWire | "cursor" | "agy";

/**
 * Provider 编辑器「本机已登录」下拉里列哪些 CLI：凡是工作台能开窗、又支持本机登录的都列。
 * 新增一种本机登录的 CLI = 这里加一项（加上探测与读模型的接线），不再另写死名单。
 */
export const LOCAL_LOGIN_PROBE_RUNTIMES: readonly LoginProbeRuntime[] = [
  "claude-code",
  "codex",
  "grok-build",
  "cursor",
  "agy",
];

/** Cursor 的账号状态（cursor:status）转成和其他 CLI 一样的登录徽章。 */
export function cursorStatusToProbeView(account: CursorAccountStatus): CliLoginProbeView {
  const probedWith = "cursor:status";
  const detail = account.detail ?? "";
  if (!account.installed) {
    return { status: "cli_missing", detail, probedWith };
  }
  if (account.authenticated === true) {
    return { status: "logged_in", detail, probedWith };
  }
  if (account.authenticated === false) {
    return { status: "logged_out", detail, probedWith };
  }
  return { status: "unknown", detail, probedWith };
}

/** agy 的账号状态（gemini:status）转成和其他 CLI 一样的登录徽章。 */
export function agyStatusToProbeView(account: GeminiAccountStatus): CliLoginProbeView {
  const probedWith = "gemini:status";
  const detail = account.detail ?? "";
  if (!account.installed) {
    return { status: "cli_missing", detail, probedWith };
  }
  if (account.authenticated === true) {
    return { status: "logged_in", detail, probedWith };
  }
  if (account.authenticated === false) {
    return { status: "logged_out", detail, probedWith };
  }
  return { status: "unknown", detail, probedWith };
}

/** 缓存 TTL（毫秒）。 */
export const CLI_LOGIN_PROBE_TTL_MS = 30_000;

interface CacheEntry {
  readonly at: number;
  readonly result: CliLoginProbeView;
}

/** 探测执行函数（生产 = invokeQuery 包装；测试注入假实现）。 */
export type ProbeRunner = (runtime: LoginProbeRuntime) => Promise<CliLoginProbeView>;

export interface CliLoginProbeCache {
  /** 取登录态：缓存新鲜即复用，在飞即共享，否则发起探测。 */
  probe(runtime: LoginProbeRuntime, force?: boolean): Promise<CliLoginProbeView>;
  /** 清空缓存（测试用）。 */
  clear(): void;
}

/** 构造探测缓存（模块级单例见下方 export；测试自建实例注入假 runner 与时钟）。 */
export function createCliLoginProbeCache(
  runner: ProbeRunner,
  now: () => number = Date.now,
  ttlMs: number = CLI_LOGIN_PROBE_TTL_MS,
): CliLoginProbeCache {
  const cache = new Map<LoginProbeRuntime, CacheEntry>();
  const inflight = new Map<LoginProbeRuntime, Promise<CliLoginProbeView>>();

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
