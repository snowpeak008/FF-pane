/**
 * Windows Job Object 圈禁（T8.2）—— 取消/超时时把子进程树整个带走。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么需要它（实测归因，与此前档案记载不同）
 * ════════════════════════════════════════════════════════════════════════════
 * 现行 `taskkill /PID <pid> /T /F` 遍历的是**当下的父子表**。若中间进程在被杀之前
 * 自己先退出，它的子进程会被系统重父化到别处——此刻那个孙进程已不在我们这棵树上，
 * `/T` **沉默地不列出它**（对仍存活的顶层 taskkill 返回 0 并报告成功；128「目标不存在」
 * 只在对已不存在的 pid 下手时出现），于是它作为孤儿继续跑。
 *
 * T8.2 开工前的四变体实测（本机 Windows 10.0.22631）：
 *   bash → sleep（中间层存活）           ☆ 未逃逸
 *   bash 后台起 sleep 后立即退出          ★ 逃逸
 *   **纯原生 node → node，中间层退出**    ★ 同样逃逸（完全不涉 msys）
 *   原生 detached 但中间层存活            ☆ 未逃逸
 * 故此前 §4.5 与 docs/adapters/claude-code.md §5 记的「msys（git-bash）进程模型断父子链」
 * **归因不准**：msys 只是碰巧常触发「中间层先退出」这个形态，纯 Windows 原生进程同样逃逸。
 *
 * Job Object 不看父子表，只看「谁被登记进了这个 Job」：进程一旦入 Job，其后代**自动**
 * 属于同一 Job（除非显式 breakaway，我们不开那个限制位），重父化不改变 Job 归属。
 * 故 `TerminateJobObject` 能带走 `/T` 带不走的那些。实测同一场景下确认有效。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 与 libuv 全局 Job 的嵌套语义：关应用即清场（T8.2 验收发现，用户 2026-09-02 裁定为期望行为）
 * ════════════════════════════════════════════════════════════════════════════
 * libuv 在 Windows 上把每个非 detached 子进程放进一个**进程级全局 Job**
 * （KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK | BREAKAWAY_OK）。T8.2 之前，CLI 的后代借该
 * Job 的静默 breakaway **不在**任何 Job 内，FF-pane 退出时它们能活下来。本模块把 CLI
 * 顶层再放进一个**不允许 breakaway** 的新 Job；按 Windows 嵌套 Job 规则「直接所属的 Job
 * 不允许 breakaway，则子进程不从任何 Job 脱离」，CLI 的全部后代自此**同时留在 libuv
 * 全局 Job 内**（验收方以 IsProcessInJob(h, NULL) 三变体实测）。后果两面：
 *   - 崩溃兜底更全：即便本 Job 句柄已按设计 close()，FF-pane 主进程一退出（正常或崩溃），
 *     CLI 留下的一切后代都被内核随 libuv 的 Job 收走；
 *   - `close()` 那条「自然结束不牵连后台进程」的边界**仅在工作台存活期间成立**：用户关掉
 *     FF-pane 时，本轮 CLI 起的开发服务器之类会被一并终止（T8.2 之前不会）。
 * 裁定：无残留优先，「关应用即清场」是期望行为；close() 里摘 KILL_ON_JOB_CLOSE 的逻辑
 * 保留——它仍是工作台存活期间「正常跑完不杀用户后台进程」的唯一保证。配套的会话续接
 * 闭环另立工单 T8.2b。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 取舍：为什么引 koffi（经用户 2026-09-01 裁定）
 * ════════════════════════════════════════════════════════════════════════════
 * Job Object 是 Win32 API，**Node 不提供任何内置入口**，不引 FFI 就只能退到
 * 「快照轮询记 pid 再按记录杀」——那对两次轮询之间出生又被重父化的孙进程仍然漏，
 * 是减轻而非根治。与技术选型里「不引 MCP SDK / 不引 LangChain」两次取舍的区别在于：
 * 那两次的判据是「自研量可控」，而这件事**没法自研**。理由回填 docs/技术选型.md §10。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 失败一律降级，不让圈禁本身成为新的故障源
 * ════════════════════════════════════════════════════════════════════════════
 * koffi 加载失败（打包漏解包、杀软拦 dlopen、将来换平台）、CreateJobObject 失败、
 * Assign 失败——任一步出问题都只是**回到 T8.2 之前的行为**（kill-tree 的 taskkill /T），
 * 绝不抛给调用方。子进程管理是取消路径的地基，它不该因为一个增强而变得更容易坏。
 */

/// <reference types="node" />

import { createRequire } from "node:module";
import process from "node:process";

/** 一次圈禁的句柄。非 Windows、或圈禁不可用时不会产出本对象。 */
export interface ProcessJob {
  /** 终止 Job 内全部进程（含被重父化的后代）。返回是否成功下手。 */
  readonly terminate: () => boolean;
  /**
   * 释放 Job 句柄，**且不连带终止里面还活着的进程**（先摘掉 KILL_ON_JOB_CLOSE 再关）。
   *
   * 为什么要刻意摘掉：本轮自然结束时，CLI 可能故意留了后台进程（Worker 的任务本身
   * 就可能是「起一个开发服务器再验证页面」）。取消要杀干净是一回事，正常跑完顺手
   * 把用户的后台进程杀了是另一回事，后者不在本单范围内，也不该静默发生。
   *
   * 这条「不牵连」**仅在工作台存活期间成立**：那些后台进程同时还留在 libuv 的全局
   * Job 内（见文件头「嵌套语义」一节），FF-pane 退出时会被一并终止——用户裁定为期望行为。
   */
  readonly close: () => void;
}

/**
 * 本模块不可用时的原因，供诊断日志（英文，check-i18n 约定）。
 *
 * 语义是「当前是否可用」而非「最近一次失败」：每次 `assignProcessToNewJob` 成功都会把它
 * 清回 null（T8.2 验收登记——此前只在 koffi 首次加载成功时清，一次 OpenProcess 因目标
 * 恰好已退出而失败后，即便之后每次 spawn 都圈禁成功，这里仍会一直报那条旧原因）。
 */
let unavailableReason: string | null = null;

export function jobObjectUnavailableReason(): string | null {
  return unavailableReason;
}

interface Kernel32 {
  readonly CreateJobObjectW: (attrs: null, name: null) => unknown;
  readonly AssignProcessToJobObject: (job: unknown, proc: unknown) => boolean;
  readonly TerminateJobObject: (job: unknown, exitCode: number) => boolean;
  readonly SetInformationJobObject: (
    job: unknown,
    cls: number,
    info: Buffer,
    len: number,
  ) => boolean;
  readonly OpenProcess: (access: number, inherit: boolean, pid: number) => unknown;
  readonly CloseHandle: (handle: unknown) => boolean;
}

/** PROCESS_SET_QUOTA | PROCESS_TERMINATE —— AssignProcessToJobObject 所需的最小权限。 */
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;

/** JOBOBJECTINFOCLASS::JobObjectExtendedLimitInformation */
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;

/**
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE：最后一个 Job 句柄关闭时终止 Job 内全部进程。
 *
 * 这是**崩溃兜底**：工作台进程若被强杀，我们的 finally 不会执行，但内核会在句柄随进程
 * 销毁时替我们收尾——不会给用户留下一堆没人管的 Agent CLI 进程。
 * 正因为有它，`close()` 只在进程已经收场之后调用（见 spawn.ts 的接线）。
 */
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

/**
 * JOBOBJECT_EXTENDED_LIMIT_INFORMATION 在 x64 下 144 字节；
 * LimitFlags 位于内嵌的 BASIC_LIMIT_INFORMATION 偏移 16 处。
 * 只写这一个字段，其余保持零（= 不设任何配额限制）。
 */
const EXTENDED_LIMIT_INFORMATION_SIZE = 144;
const LIMIT_FLAGS_OFFSET = 16;

let kernel32: Kernel32 | null | undefined;

/** 懒加载 kernel32 绑定；失败只记原因并返回 null（调用方降级）。 */
function loadKernel32(): Kernel32 | null {
  if (kernel32 !== undefined) {
    return kernel32;
  }
  if (process.platform !== "win32") {
    unavailableReason = "not win32";
    kernel32 = null;
    return null;
  }
  try {
    // 同步 require 而非 import()：本函数要能被同步的 spawn 路径调用（圈禁必须紧跟
    // spawn，不能隔一个 await）。用 createRequire 是因为本包是 ESM。
    // 动态加载还有两个好处：非 Windows 不为用不上的原生模块付加载代价；
    // koffi 缺席（打包漏解包、杀软拦截）表现为降级而不是启动即崩。
    const require = createRequire(import.meta.url);
    const koffi = require("koffi") as {
      load: (lib: string) => { func: (proto: string) => never };
    };
    const lib = koffi.load("kernel32.dll");
    kernel32 = {
      CreateJobObjectW: lib.func("void* CreateJobObjectW(void* attrs, const char16_t* name)"),
      AssignProcessToJobObject: lib.func("bool AssignProcessToJobObject(void* job, void* proc)"),
      TerminateJobObject: lib.func("bool TerminateJobObject(void* job, uint32_t exitCode)"),
      SetInformationJobObject: lib.func(
        "bool SetInformationJobObject(void* job, int cls, void* info, uint32_t len)",
      ),
      OpenProcess: lib.func("void* OpenProcess(uint32_t access, bool inherit, uint32_t pid)"),
      CloseHandle: lib.func("bool CloseHandle(void* h)"),
    } as unknown as Kernel32;
    unavailableReason = null;
    return kernel32;
  } catch (error) {
    unavailableReason = `koffi load failed: ${(error as Error).message}`;
    kernel32 = null;
    return null;
  }
}

/**
 * 把指定进程圈进一个新建的 Job。
 *
 * **必须在 spawn 之后尽早调用**：进程在入 Job 之前派生的后代不属于该 Job。
 * 实测 spawn→assign 窗口约 28 µs，且最坏情况（子进程一起来就 fork 孙进程）
 * 仍圈得住——Windows 的 CreateProcess 本身要花掉远多于此的时间。
 *
 * @returns 圈禁句柄；平台不支持 / 加载失败 / 任一步失败均返回 undefined（调用方降级）。
 */
export function assignProcessToNewJob(pid: number): ProcessJob | undefined {
  const api = loadKernel32();
  if (api === null) {
    return undefined;
  }

  let job: unknown;
  let processHandle: unknown;
  try {
    job = api.CreateJobObjectW(null, null);
    if (job === null || job === undefined) {
      unavailableReason = "CreateJobObject returned null";
      return undefined;
    }

    const info = Buffer.alloc(EXTENDED_LIMIT_INFORMATION_SIZE);
    info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, LIMIT_FLAGS_OFFSET);
    // 设不上限制位不致命：Job 仍能 Terminate，只是少了「本进程崩溃时内核代为收尾」。
    api.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, info.length);

    processHandle = api.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
    if (processHandle === null || processHandle === undefined) {
      api.CloseHandle(job);
      unavailableReason = `OpenProcess failed for pid ${String(pid)}`;
      return undefined;
    }

    if (!api.AssignProcessToJobObject(job, processHandle)) {
      api.CloseHandle(processHandle);
      api.CloseHandle(job);
      unavailableReason = `AssignProcessToJobObject failed for pid ${String(pid)}`;
      return undefined;
    }
    // 进程句柄的使命到此为止（Job 已持有归属），提前还掉免得攥着一个多余句柄。
    api.CloseHandle(processHandle);
    // 圈禁成立即「当前可用」，把此前可能残留的失败原因清掉
    unavailableReason = null;

    let closed = false;
    return {
      terminate: () => {
        if (closed) {
          return false;
        }
        try {
          return api.TerminateJobObject(job, 1);
        } catch {
          return false;
        }
      },
      close: () => {
        if (closed) {
          return;
        }
        closed = true;
        try {
          // 先摘掉 KILL_ON_JOB_CLOSE：本轮已收场，关句柄不该顺带杀掉 CLI 故意留下的
          // 后台进程（仅在工作台存活期间成立，见文件头「嵌套语义」）。
          // 摘不掉也只是回到「关句柄即终止」，不影响本轮正确性，故不检查返回值。
          const cleared = Buffer.alloc(EXTENDED_LIMIT_INFORMATION_SIZE);
          api.SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            cleared,
            cleared.length,
          );
          api.CloseHandle(job);
        } catch {
          // 句柄释放失败无从补救，也不该升级为调用方的错误
        }
      },
    };
  } catch (error) {
    unavailableReason = `job object setup failed: ${(error as Error).message}`;
    try {
      if (processHandle !== undefined && processHandle !== null) {
        api.CloseHandle(processHandle);
      }
      if (job !== undefined && job !== null) {
        api.CloseHandle(job);
      }
    } catch {
      // 同上
    }
    return undefined;
  }
}
