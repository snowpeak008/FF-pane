/**
 * 退出协调器（T8.2b；T8.5c 增补常驻 Runtime 资源关停）：把 Electron `before-quit`
 * 的时序规则收成一个不依赖 Electron 的模块。
 *
 * 规则：
 * 1. 没有在飞轮次**且无常驻 Runtime 资源** → 不拦截，让 Electron 照常退出
 *    （零成本路径，也是绝大多数退出——opencode server 惰性，从未派发过就从未起）；
 * 2. 有在飞轮次 → 首次触发 `preventDefault()`，调编排器 `prepareForQuit()` 就地收尾
 *    （transcript / Run / 任务 / 标记），完成后再调 `quit()`；
 * 3. 总时长上限 QUIT_TOTAL_BUDGET_MS：超时照样 `quit()`——没写完的由启动修正兜底，
 *    子进程由 Job Object 兜底（T8.2），用户点了关就该关；
 * 4. 防重入：收尾期间再次触发（用户连点 / 系统重复派发）只 `preventDefault()`，不重复收尾；
 *    我们自己调 `quit()` 引发的那次 `before-quit` 放行（否则永远退不出去）。
 * 5. **常驻 Runtime 资源关停（T8.5c，OpenCode server）**：`closeRuntimes` 在
 *    prepareForQuit **之后**执行——取消波经 HTTP /abort 打到 server，先关 server
 *    会让 abort 失联并触发适配器的 restart 兜底（退出期间重启是反向操作）。
 *    关停有自己的小预算 QUIT_RUNTIME_CLOSE_BUDGET_MS（**不并入** 3 s 总预算：
 *    3 s 是按「取消子进程 ≤ 1.5 s」定的，把关停塞进去会在收尾顶满预算时把 server
 *    留成孤儿）；超预算照样 quit——server 经 spawnAgentProcess 入 Job
 *    （KILL_ON_JOB_CLOSE）且在 libuv 全局 Job 内，进程退出时内核代为收尾。
 *    无在飞轮但 server 活着（轮次全部正常结束的会话后退出）时也拦截一次：只走
 *    关停这一段（≤ 1 s），不跑 prepare。
 *
 * 依赖全注入（hasInflight / prepare / quit / setTimeout），Electron 的 `app` 只在 main/index.ts
 * 接线处出现，故本模块可在 node 环境单测。
 */

/** 退出收尾的总时长上限（含 prepareForQuit 内部对取消的 1.5 s 等待）。 */
export const QUIT_TOTAL_BUDGET_MS = 3_000;

/**
 * 常驻 Runtime 资源（opencode serve）关停的时长上限（T8.5c）。
 *
 * 数字依据：`OpenCodeAdapter.close()` 是强制树杀（Job Object Terminate / taskkill
 * /T /F），**无优雅 HTTP shutdown 需求**——OpenCode 会话持久化在 SQLite 单库
 * （调研 §5），强杀不丢数据、会话可续（§6 CLI 路径同款语义）。真机实测
 * （live-opencode.mjs，opencode 1.18.25，2026-09-05，两次实跑）close() 耗时
 * **296 / 353 ms**，1 s ≈ 3 倍裕量；超时照样退出，进程由 Job Object（KILL_ON_JOB_CLOSE）+
 * libuv 全局 Job 双兜底收尾。**不并入 3 s 总预算的理由**见模块头规则 5。
 */
export const QUIT_RUNTIME_CLOSE_BUDGET_MS = 1_000;

/** 协调器依赖。 */
export interface QuitCoordinatorDeps {
  /** 是否还有在飞轮次（无则不为收尾拦截）。 */
  readonly hasInflight: () => boolean;
  /** 就地收尾（编排器 prepareForQuit）。抛错视同完成——不能因为收尾出错而退不出去。 */
  readonly prepare: () => Promise<unknown>;
  /**
   * 是否有常驻 Runtime 资源要关停（T8.5c：opencode server 起过且未收）。
   * 缺省视为无——只接了编排器没接注册表的宿主不受影响。
   */
  readonly hasRuntimeResources?: () => boolean;
  /** 关停常驻 Runtime 资源（注册表 closeRuntimes，幂等）。抛错视同完成。 */
  readonly closeRuntimes?: () => Promise<unknown>;
  /** 收尾完成 / 超时后真正退出（接线为 app.quit）。 */
  readonly quit: () => void;
  /** 记一行诊断日志（英文，开发者日志约定）。 */
  readonly log?: (message: string) => void;
  /** 收尾时长上限；缺省 QUIT_TOTAL_BUDGET_MS。 */
  readonly budgetMs?: number;
  /** Runtime 资源关停时长上限；缺省 QUIT_RUNTIME_CLOSE_BUDGET_MS。 */
  readonly runtimeCloseBudgetMs?: number;
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
  const closeBudgetMs = deps.runtimeCloseBudgetMs ?? QUIT_RUNTIME_CLOSE_BUDGET_MS;
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

  /** 一段带独立预算的收尾步骤：完成或超时都放行（返回结果供日志措辞）。 */
  function raceBudget(step: Promise<unknown>, ms: number): Promise<"done" | "timeout"> {
    let timer: unknown;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = timers.setTimeout(() => resolve("timeout"), ms);
    });
    return Promise.race([step.then(() => "done" as const), timeout]).then((outcome) => {
      timers.clearTimeout(timer);
      return outcome;
    });
  }

  /** 关停常驻 Runtime 资源（有则关，独立小预算——见模块头规则 5）。 */
  async function closeRuntimeResources(): Promise<void> {
    if (deps.closeRuntimes === undefined || deps.hasRuntimeResources?.() !== true) {
      return;
    }
    log("[quit] closing runtime resources (opencode server)");
    const closing = deps.closeRuntimes().catch((thrown: unknown) => {
      log(`[quit] closeRuntimes failed: ${String(thrown)}`);
    });
    const outcome = await raceBudget(closing, closeBudgetMs);
    if (outcome === "timeout") {
      // 超预算照样退：进程在 Job（KILL_ON_JOB_CLOSE）+ libuv 全局 Job 内，
      // FF-pane 退出时内核代为收尾（T8.2 关应用即清场语义）。
      log(`[quit] runtime close budget ${closeBudgetMs} ms exceeded; job object will reap`);
    }
  }

  function onBeforeQuit(event: PreventableEvent): void {
    if (phase === "quitting") {
      return;
    }
    if (phase === "preparing") {
      event.preventDefault();
      return;
    }
    const inflight = deps.hasInflight();
    if (!inflight && deps.hasRuntimeResources?.() !== true) {
      phase = "quitting";
      return;
    }
    event.preventDefault();
    phase = "preparing";
    log(
      inflight
        ? "[quit] in-flight turns present; settling before quit"
        : "[quit] runtime resources present; closing before quit",
    );

    const prepared = inflight
      ? raceBudget(
          deps.prepare().catch((thrown: unknown) => {
            log(`[quit] prepareForQuit failed: ${String(thrown)}`);
          }),
          budgetMs,
        )
      : Promise.resolve("done" as const);
    void prepared
      // 先收尾（取消波要经 server 的 /abort 端点）再关 server，见模块头规则 5
      .then((outcome) => closeRuntimeResources().then(() => outcome))
      .then((outcome) => {
        finishAndQuit(
          outcome === "done" ? "quit sequence settled" : `budget ${budgetMs} ms exceeded`,
        );
      });
  }

  return { onBeforeQuit, phase: () => phase };
}
