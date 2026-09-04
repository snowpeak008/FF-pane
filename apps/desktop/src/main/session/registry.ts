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
 * grok-build）维持裸 runtime 键单例不变。规则：
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
 * OpenCode（需常驻 server + close 生命周期）暂不默认注册，就绪评估见
 * `docs/开发进度.md` §0 T8.4b 节（before-quit 钩子已就位，尚缺 server close
 * 接线与退出预算合并等，注册实现留待其工单）。
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
} from "@ff-pane/adapters";
import type { AgentProfile } from "@ff-pane/shared";

/** 装配选项。 */
export interface DesktopAdapterRegistryOptions {
  /**
   * aider 按 Profile 的 transcript 根目录（`<全局数据根>/agent-sessions`）。
   * 每个 aider Profile 的实例注入 `tempDir = <本目录>/<profileId>`。
   */
  readonly agentSessionsDir: string;
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

/** 桌面注册表：裸键 AdapterRegistry + 按 Profile 的复合键解析。 */
export interface DesktopAdapterRegistry extends AdapterRegistry, ProfileAdapterResolver {}

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
  };
}
