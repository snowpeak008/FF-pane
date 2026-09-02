/**
 * 退出协调器（T8.2b）：把 Electron `before-quit` 的时序规则收成一个不依赖 Electron 的模块。
 *
 * 规则：
 * 1. 没有在飞轮次 → 不拦截，让 Electron 照常退出（零成本路径，也是绝大多数退出）；
 * 2. 有在飞轮次 → 首次触发 `preventDefault()`，调编排器 `prepareForQuit()` 就地收尾
 *    （transcript / Run / 任务 / 标记），完成后再调 `quit()`；
 * 3. 总时长上限 QUIT_TOTAL_BUDGET_MS：超时照样 `quit()`——没写完的由启动修正兜底，
 *    子进程由 Job Object 兜底（T8.2），用户点了关就该关；
 * 4. 防重入：收尾期间再次触发（用户连点 / 系统重复派发）只 `preventDefault()`，不重复收尾；
 *    我们自己调 `quit()` 引发的那次 `before-quit` 放行（否则永远退不出去）。
 *
 * 依赖全注入（hasInflight / prepare / quit / setTimeout），Electron 的 `app` 只在 main/index.ts
 * 接线处出现，故本模块可在 node 环境单测。
 */

/** 退出收尾的总时长上限（含 prepareForQuit 内部对取消的 1.5 s 等待）。 */
export const QUIT_TOTAL_BUDGET_MS = 3_000;

/** 协调器依赖。 */
export interface QuitCoordinatorDeps {
  /** 是否还有在飞轮次（无则不拦截）。 */
  readonly hasInflight: () => boolean;
  /** 就地收尾（编排器 prepareForQuit）。抛错视同完成——不能因为收尾出错而退不出去。 */
  readonly prepare: () => Promise<unknown>;
  /** 收尾完成 / 超时后真正退出（接线为 app.quit）。 */
  readonly quit: () => void;
  /** 记一行诊断日志（英文，开发者日志约定）。 */
  readonly log?: (message: string) => void;
  /** 总时长上限；缺省 QUIT_TOTAL_BUDGET_MS。 */
  readonly budgetMs?: number;
  /** 定时器注入（单测用假时钟）；缺省全局 setTimeout / clearTimeout。 */
  readonly timers?: {
    readonly setTimeout: (fn: () => void, ms: number) => unknown;
    readonly clearTimeout: (handle: unknown) => void;
  };
}

/** before-quit 事件里协调器唯一用到的能力。 */
export interface PreventableEvent {
  preventDefault(): void;
}

/** 协调器：把 `onBeforeQuit` 挂到 `app.on("before-quit")` 即可。 */
export interface QuitCoordinator {
  onBeforeQuit(event: PreventableEvent): void;
  /** 当前阶段（诊断 / 单测）。 */
  phase(): QuitPhase;
}

/** idle → preparing → quitting（quitting 阶段的 before-quit 一律放行）。 */
export type QuitPhase = "idle" | "preparing" | "quitting";

export function createQuitCoordinator(deps: QuitCoordinatorDeps): QuitCoordinator {
  const timers = deps.timers ?? {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const budgetMs = deps.budgetMs ?? QUIT_TOTAL_BUDGET_MS;
  const log = deps.log ?? (() => undefined);
  let phase: QuitPhase = "idle";

  function finishAndQuit(why: string): void {
    if (phase === "quitting") {
      return;
    }
    phase = "quitting";
    log(`[quit] ${why}; quitting now`);
    deps.quit();
  }

  function onBeforeQuit(event: PreventableEvent): void {
    if (phase === "quitting") {
      return;
    }
    if (phase === "preparing") {
      event.preventDefault();
      return;
    }
    if (!deps.hasInflight()) {
      phase = "quitting";
      return;
    }
    event.preventDefault();
    phase = "preparing";
    log("[quit] in-flight turns present; settling before quit");

    let timer: unknown;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = timers.setTimeout(() => resolve("timeout"), budgetMs);
    });
    const prepared = deps
      .prepare()
      .then(() => "done" as const)
      .catch((thrown: unknown) => {
        log(`[quit] prepareForQuit failed: ${String(thrown)}`);
        return "done" as const;
      });
    void Promise.race([prepared, timeout]).then((outcome) => {
      timers.clearTimeout(timer);
      finishAndQuit(
        outcome === "done" ? "in-flight turns settled" : `budget ${budgetMs} ms exceeded`,
      );
    });
  }

  return { onBeforeQuit, phase: () => phase };
}
