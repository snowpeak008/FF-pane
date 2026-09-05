/**
 * 桌面适配器注册表装配（T4.2；T8.4b 接入多实例规约）。
 *
 * 主进程持有唯一注册表，编排层按 Profile 取用（resolveForProfile）。
 * M1 注册三家零参构造的 L1 stdio 适配器（Codex / Claude Code / Gemini CLI）——
 * 它们凭 env 注入的密钥即可运行，最贴合 M1 的常见配置。
 * T7.3 增补 Grok Build：同样零参可构造（凭 `XAI_API_KEY` 或用户已有的 `grok login` 登录态），
 * 故并入默认注册。
 * T7.3b 增补 Aider：零参可构造，凭 env 注入的 `OPENAI_API_KEY` 运行。它没有 cli_login
 * 登录态可退（aider.md §5.2），故密钥缺席时适配器会在 spawn 前快速失败——
 * 这是刻意的：缺密钥的 aider 会唤起浏览器做 OAuth（§7.3 坑 1）。
 *
 * ## 多实例注册键规约（T8.3a 定稿；T8.4b 实现）
 *
 * **按 Profile 逐实例化，注册键为 `<runtime>@<profileId>` 复合键**（如
 * `generic-exec@prof-abc`）；无构造期配置的适配器（codex / claude-code / gemini-cli /
 * grok-build / opencode（T8.5c 起）/ qwen-code（T8.6a 起）/ iflow（T8.6b 起——
 * managedHome 是进程级常量非按 Profile 配置，见下方注册处注释））维持裸 runtime
 * 键单例不变。规则：
 * 1. 编排层取用一律走 resolveForProfile：带构造期配置的 runtime（generic-exec /
 *    aider）按 `<profile.runtime>@<profile.id>` 命中专属实例，其余退回裸
 *    `profile.runtime`——零配置适配器一行不改（resolveForProfile 对它们就是
 *    `registry.get` 的透传，单测以实例同一性钉住）；
 * 2. 复合键实例**惰性构造 + 配置指纹缓存**（首次派发时构造，Profile 更新导致
 *    构造期配置变化时按指纹失配重建）。不挂 Profile CRUD 钩子的理由：两类实例都是
 *    无常驻资源的轻量闭包（spawn 发生在 startTurn、进程句柄住在轮次闭包里），
 *    Profile 删除后 loadProfile 已在受理入口挡住新派发，残留缓存条目不持有任何
 *    OS 资源、数量以历史 Profile 数为上界，无泄漏；跨 data 层 / session 层接
 *    删除通知的复杂度与收益不成比例；
 * 3. `KNOWN_RUNTIMES` 与 `Profile.runtime` 的取值不变（仍是裸 runtime）——复合键
 *    是注册表内部寻址方案，不进领域模型、不进 UI 下拉框。
 * 两案对比（T8.3a 决策依据，调研后维持主管理员方向）：
 * - 案 A（选定）按 Profile 逐实例化：Profile 本就是「runtime + 配置」的既有聚合根
 *   （generic-exec 的命令模板、aider 的 tempDir 都随 Profile 走），无需新增“工具实例”
 *   实体与其 CRUD / 存储 / UI；同一 CLI 想配两套参数 = 建两个 Profile，与用户心智一致。
 *   代价：两个 Profile 配置完全相同也会各持一个实例——但适配器实例只是轻量闭包
 *   （无常驻进程，spawn 发生在 startTurn），重复实例无实际成本。
 * - 案 B 独立“工具实例”注册（键 = 用户命名的实例 ID，Profile 引用实例）：可跨 Profile
 *   复用同一配置，但要新增一层实体 + 存储 + 设置页管理 + Profile 迁移，而“复用配置”
 *   在 Profile 数量个位数的现实下收益趋零。复杂度不成比例，弃。
 *
 * ## generic-exec（T8.4b）
 *
 * 构造期配置取自 `profile.genericExec`（command / args / taskDelivery 最小集，
 * core 校验器在落盘前把关）。配置缺失（手改 profiles.json 等旁路）或构造期校验
 * 失败（GenericExecConfigError）不抛：返回人可读拒绝，替代此前的「Runtime 未注册」
 * ——用户能据此去设置页补配置，而不是对着一个装配术语发懵。
 *
 * ## aider tempDir（T8.2b-a 登记 → T8.3a 候选② → T8.4b 落地）
 *
 * 按 Profile 实例化时经构造期选项注入
 * `tempDir = <全局数据根>/agent-sessions/<profileId>/`（默认
 * `~/.aiworkbench/agent-sessions/…`，E2E 经 FF_PANE_DATA_ROOT 隔离）：transcript
 * 出系统临时目录、随 Profile 隔离、重启后仍在（会话登记的 nativeSessionId 即该
 * 文件的绝对路径）。目录按需创建——适配器 startTurn 里的
 * `mkdirSync(sessionDir, { recursive: true })` 会连同 tempDir 一并建出，装配层
 * 不必预建。仍是**适配器级**目录（跨项目共用），轮次级位置须候选①（改适配器
 * 接口），归后续裁定。注：编排层的 native 恢复门槛是 `nativeResume === "yes"`，
 * 而 aider 声明 "partial"，故续接轮走 context_rebuild、不经 ctx.resume 消费该
 * transcript——本次接线保证的是「文件寿命可控、不再被系统清理」，是否放宽
 * partial 进 native 恢复归主管理员另裁。
 *
 * ## OpenCode（T8.5c 注册接入，T8.4b 就绪评估四缺口收口）
 *
 * 裸键单例注册（零构造期配置——与 codex 等同款），但**server 进程惰性**：
 * `createOpenCodeAdapter()` / `createOpenCodeServer()` 只是轻量闭包，首次派发的
 * `ensureReady()` 才 spawn `opencode serve`——注册本身零成本，与 T8.4b 惰性构造
 * 款式同精神（差别只在惰性落在 server 层而非适配器层，因为适配器无按 Profile
 * 的构造期配置）。
 *
 * **server 共享决策（两案对比，维持主管理员方向）**：
 * - 案 A（选定）**进程级单 server 共享**：OpenCode 一个 serve 实例本就服务多项目
 *   多会话（调研 §2.2：请求带 directory 参数；§5：会话库全局 SQLite 单库），按
 *   Profile 各起一个只是复数份端口 + 内存 + 3~5 s 冷启动，换不来任何隔离收益。
 *   调研核实**无「全局配置绑定 Profile」问题**：Provider 凭证经 spawn 期环境变量
 *   吸收（§4.3），而 desktop 对 opencode **零 env 注入**（env.ts 默认分支——
 *   Provider 在 OpenCode 自身配置内声明），全部轮次 env 指纹相同，共享 server
 *   永不触发指纹冲突。将来若按 Profile 注入凭证（OPENCODE_CONFIG_CONTENT），
 *   server 层的 env 指纹绑定会拒绝有活跃轮次时的抢占（server.ts 头注）——届时
 *   再改按 Profile 实例化，本注册表已有现成款式（resolveGenericExec/resolveAider）。
 * - 案 B 按 Profile 各起 server：唯一收益是 env 指纹天然隔离，但当前零注入用不上；
 *   代价是每 Profile 一个常驻进程 + 端口 + 退出时逐个关停。弃。
 *
 * **退出收敛（T8.4b 缺口 ①②）**：`closeRuntimes()` 关停 server（幂等），由
 * quit 协调器在 prepareForQuit **之后**调用——取消波经 HTTP /abort 打到 server，
 * 先关 server 会让 abort 失败并触发适配器的 restart 兜底（退出期间重启是反向
 * 操作）。`hasRuntimeResources()` 供 quit 协调器判断「无在飞轮但 server 还活着」
 * 时也要拦截一次退出来关停。崩溃兜底：server 经 spawnAgentProcess 起，spawn 后
 * 即入 Job（KILL_ON_JOB_CLOSE）且在 libuv 全局 Job 内——FF-pane 崩溃时内核代为
 * 收尾（T8.2 关应用即清场语义，§4.5 已落档）。
 */

import path from "node:path";
import {
  type AdapterRegistry,
  type AgentAdapter,
  createAdapterRegistry,
  createAiderAdapter,
  createClaudeCodeAdapter,
  createCodexAdapter,
  createGeminiCliAdapter,
  createGenericExecAdapter,
  createGrokBuildAdapter,
  createIFlowAdapter,
  createOpenCodeAdapter,
  createQwenCodeAdapter,
  type OpenCodeAdapter,
} from "@ff-pane/adapters";
import type { AgentProfile } from "@ff-pane/shared";

/** 装配选项。 */
export interface DesktopAdapterRegistryOptions {
  /**
   * aider 按 Profile 的 transcript 根目录（`<全局数据根>/agent-sessions`）。
   * 每个 aider Profile 的实例注入 `tempDir = <本目录>/<profileId>`。
   */
  readonly agentSessionsDir: string;
  /**
   * OpenCode 适配器注入口（单测替身用；缺省 `createOpenCodeAdapter()`——
   * 零构造期配置、server 惰性，见模块头 OpenCode 一节）。
   */
  readonly openCodeAdapter?: OpenCodeAdapter | undefined;
  /**
   * iFlow 受管 HOME 目录（`<全局数据根>/iflow-home`，T8.6b）。spawn 时替换子进程
   * USERPROFILE/HOME 指向它——iFlow 的 settings 恒在 `os.homedir()/.iflow/`、不受
   * IFLOW_HOME 影响（iflow.md §5.4 坑 5），这是唯一能同时隔离 settings 与会话
   * 存储、且不碰用户真实 `~/.iflow` 的路径。目录与静态 settings 由适配器
   * startTurn 按需建出，装配层不必预建。
   */
  readonly iflowHomeDir: string;
}

/** 按 Profile 解析适配器的结果：命中实例或人可读拒绝原因（经 ack.reason 上行）。 */
export type ProfileAdapterResolution =
  | { readonly ok: true; readonly adapter: AgentAdapter }
  | { readonly ok: false; readonly reason: string };

/** 编排层消费的最小接口（测试替身只需实现这一个方法）。 */
export interface ProfileAdapterResolver {
  /** 按 Profile 解析适配器：复合键专属实例优先，零配置 runtime 退回裸键单例。 */
  resolveForProfile(profile: AgentProfile): ProfileAdapterResolution;
}

/** 桌面注册表：裸键 AdapterRegistry + 按 Profile 的复合键解析 + 常驻资源生命周期。 */
export interface DesktopAdapterRegistry extends AdapterRegistry, ProfileAdapterResolver {
  /**
   * 是否有需要退出前关停的常驻 Runtime 资源（T8.5c：opencode serve 起过且
   * 尚未关停）。quit 协调器据此在「无在飞轮次」时也拦截一次退出来关 server。
   */
  hasRuntimeResources(): boolean;
  /**
   * 关停全部常驻 Runtime 资源（幂等）。当前仅 OpenCode server；由退出路径在
   * prepareForQuit（取消波经 HTTP /abort 打到 server）**之后**调用。
   */
  closeRuntimes(): Promise<void>;
}

/** 复合键缓存条目：构造期配置的指纹 + 实例（指纹失配即重建，见模块头第 2 条）。 */
interface CachedInstance {
  readonly fingerprint: string;
  readonly adapter: AgentAdapter;
}

/** 复合键（T8.3a 规约：`<runtime>@<profileId>`）。 */
function compositeKey(profile: AgentProfile): string {
  return `${profile.runtime}@${profile.id}`;
}

/** 裸键未注册时的拒绝（沿用既有文案，编排器单测钉住）。 */
function unregisteredRuntime(runtime: string): ProfileAdapterResolution {
  return { ok: false, reason: `Runtime 未注册：${runtime}` };
}

/** 装配并返回桌面主进程的适配器注册表。 */
export function createDesktopAdapterRegistry(
  options: DesktopAdapterRegistryOptions,
): DesktopAdapterRegistry {
  const registry = createAdapterRegistry();
  registry.register(createCodexAdapter());
  registry.register(createClaudeCodeAdapter());
  registry.register(createGeminiCliAdapter());
  registry.register(createGrokBuildAdapter());
  // 裸键 aider 保留注册（registry.get("aider") 的既有行为不变——零参、tmpdir 缺省）；
  // 编排层经 resolveForProfile 取用的恒是复合键的按 Profile 实例（tempDir 已注入）。
  registry.register(createAiderAdapter());
  // OpenCode（T8.5c）：裸键单例，进程级单 server 共享（构造是轻量闭包，serve
  // 进程惰性——首次派发的 ensureReady 才 spawn）。能力声明按 Server 路径六项
  // 全 yes（adapter.ts OPENCODE_SERVER_CAPABILITIES），选路决策见模块头。
  const openCode = options.openCodeAdapter ?? createOpenCodeAdapter();
  registry.register(openCode);
  // Qwen Code（T8.6a）：裸键单例，零构造期配置（codex 款式）。凭 env 注入的
  // OPENAI_API_KEY（+ OPENAI_BASE_URL）即可运行——--auth-type openai 是适配器
  // 默认下发；一轮一 spawn 无常驻资源，不参与 hasRuntimeResources/closeRuntimes。
  registry.register(createQwenCodeAdapter());
  // iFlow（T8.6b）：裸键单例。managedHome 是进程级常量（全局数据根派生、不随
  // Profile 变），不构成「按 Profile 构造期配置」——与 aider 的 tempDir（按
  // profileId 派生、须复合键）不同类；模型经 ctx.model、密钥经 ctx.env 均是
  // 轮次级通道，故维持裸键（codex 款式）。ACP 一轮一 spawn 无常驻资源，
  // 不参与 hasRuntimeResources/closeRuntimes。
  registry.register(createIFlowAdapter({ managedHome: options.iflowHomeDir }));

  const instances = new Map<string, CachedInstance>();

  /** 指纹命中即复用，失配（Profile 更新改了构造期配置）即重建并替换。 */
  function cached(key: string, fingerprint: string, build: () => AgentAdapter): AgentAdapter {
    const hit = instances.get(key);
    if (hit !== undefined && hit.fingerprint === fingerprint) {
      return hit.adapter;
    }
    const adapter = build();
    instances.set(key, { fingerprint, adapter });
    return adapter;
  }

  function resolveGenericExec(profile: AgentProfile): ProfileAdapterResolution {
    const config = profile.genericExec;
    if (config === undefined) {
      // 常规路径到不了这里（core 校验器要求 generic-exec Profile 必带配置），
      // 只有手改 profiles.json 等旁路会触发；拒绝原因指向可行动的修复入口。
      return {
        ok: false,
        reason:
          `Profile「${profile.name}」缺少 generic-exec 命令配置` +
          "（command / args / taskDelivery）：请到设置页编辑该 Profile 补全后再派发",
      };
    }
    const fingerprint = JSON.stringify([config.command, config.args, config.taskDelivery]);
    try {
      return {
        ok: true,
        adapter: cached(compositeKey(profile), fingerprint, () =>
          createGenericExecAdapter({
            command: config.command,
            args: config.args,
            taskDelivery: config.taskDelivery,
            displayName: profile.name,
          }),
        ),
      };
    } catch (thrown) {
      // GenericExecConfigError（配置经旁路写入且非法）：violations 概要即人可读原因。
      return { ok: false, reason: thrown instanceof Error ? thrown.message : String(thrown) };
    }
  }

  function resolveAider(profile: AgentProfile): ProfileAdapterResolution {
    const tempDir = path.join(options.agentSessionsDir, profile.id);
    return {
      ok: true,
      // tempDir 由 profileId 派生、恒定，指纹即它（agentSessionsDir 进程内不变）。
      adapter: cached(compositeKey(profile), tempDir, () => createAiderAdapter({ tempDir })),
    };
  }

  function resolveForProfile(profile: AgentProfile): ProfileAdapterResolution {
    if (profile.runtime === "generic-exec") {
      return resolveGenericExec(profile);
    }
    if (profile.runtime === "aider") {
      return resolveAider(profile);
    }
    const adapter = registry.get(profile.runtime);
    return adapter === undefined ? unregisteredRuntime(profile.runtime) : { ok: true, adapter };
  }

  return {
    register: (adapter) => registry.register(adapter),
    get: (runtime) => registry.get(runtime),
    list: () => registry.list(),
    resolveForProfile,
    hasRuntimeResources: (): boolean => {
      const state = openCode.server.status().state;
      // stopped = 从未起过（惰性未触发）或已被 idle 关停；closed = 已收尾。
      // 其余（starting / ready / crashed）都可能有进程或启动中的 promise 要收。
      return state !== "stopped" && state !== "closed";
    },
    closeRuntimes: (): Promise<void> => openCode.close(),
  };
}
