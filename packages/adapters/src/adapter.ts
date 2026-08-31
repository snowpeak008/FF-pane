/**
 * AgentAdapter 统一接口与注册表（W2.1c，主管理员执行）。
 *
 * 接口形态的核心决策：**每轮一开（turn model），没有 send()**。
 * - 依据 codex.md §1.1：codex exec 本就是"一次进程 = 一轮"，多轮靠反复
 *   spawn `exec resume`；claude -p / gemini -p 同理是单发模式。turn 模型是
 *   四家的最大公约数：一轮 = startTurn(ctx)，多轮连续性用 ctx.resume
 *   （NativeSessionBinding，ID + cwd 成对）表达。
 * - opencode 适配器（W2.6）内部托管常驻 `opencode serve`，对外仍呈现 turn
 *   模型——常驻是它的实现细节，不上升为接口概念。
 * - 若未来 ACP（M3）需要长会话双工，届时在接口上加能力位扩展，不预先设计。
 *
 * 权限回执走 turn 句柄的可选方法：只有 claude（stdio 控制协议）与 opencode
 * （Server 路径）有原生审批通道（调研能力核对第 5 项），其余家由 W2.7 权限层
 * 在事件流外自产请求，不经过本接口。
 */

import type { ModelId, NativeSessionBinding, RuntimeId } from "@ff-pane/shared";
import { createLiteralGuard } from "@ff-pane/shared";
import type { AdapterCapabilities, AgentEvent } from "./events/index.js";

/**
 * M1/M2 计划内的 Runtime 注册键（开发计划 §16.2 / 设计文档 §5.3 覆盖矩阵）。
 * W1.1 有意让 RuntimeId 保持开放 string 别名，权威闭合清单落在本注册表：
 * M2+ 增补新 Runtime 只改这里与新适配器工单，shared 不动。
 */
export const KNOWN_RUNTIMES = [
  "codex",
  "claude-code",
  "gemini-cli",
  "opencode",
  "generic-exec",
] as const;

/** 已知 Runtime 注册键。 */
export type KnownRuntime = (typeof KNOWN_RUNTIMES)[number];

/** KnownRuntime 运行时守卫（Profile 读入 / UI 下拉框校验）。 */
export const isKnownRuntime = createLiteralGuard(KNOWN_RUNTIMES);

/**
 * 一个经 stdio 接入的 MCP 服务端（T6.6，设计文档 §8.3.5 路径二）。
 *
 * **只支持 stdio，不支持 http/sse**，这是刻意收窄的：本产品要接的是自己的只读检索
 * 服务端，进程间管道不占端口、不产生网络流量，因此与用户的 VPN、系统代理、防火墙
 * 规则完全无关。留一个 url 字段就意味着日后会有人往里填一个要走网络的地址。
 */
export interface McpStdioServerSpec {
  /** 服务端可执行文件。 */
  readonly command: string;
  /** 启动参数。 */
  readonly args?: readonly string[];
  /**
   * 注入给服务端进程的环境变量。
   *
   * **不得放密钥**：各 Runtime 承载它的方式不同——codex 走 `-c` 命令行参数（在进程
   * 列表里肉眼可见）、claude 走临时 JSON 配置文件（落盘）。两者都与 §4.3「密钥只经
   * env 直接下发给 Agent 进程、不落盘不进命令行」相抵触。这里只该放路径一类的非机密项。
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * 该服务端中要**预先放行**的工具名（不带 `mcp__<服务器>__` 前缀，适配器自行加）。
   *
   * 支持逐工具审批的 Runtime（claude）据此免掉审批弹窗。只该列真正无副作用的工具：
   * 本产品注入的只有只读检索，故列它是安全的；若将来注入有副作用的服务端，
   * 这里留空、让它照常走审批通道才是对的。
   */
  readonly allowedTools?: readonly string[];
}

/** 权限审批决定（用户在 UI 上的二选一，经 IPC 下行到适配器回执原生请求）。 */
export const PERMISSION_DECISIONS = ["allow", "deny"] as const;

/** 权限审批决定。 */
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

/** PermissionDecision 运行时守卫。 */
export const isPermissionDecision = createLiteralGuard(PERMISSION_DECISIONS);

/**
 * 一轮会话的启动上下文。
 *
 * 密钥红线（设计文档 §4.3）：env 是唯一的密钥下发通道——主进程经 revealSecret
 * 取明文后放入本表，由 process 层（W2.1a）以"清洗后注入"语义传给子进程，
 * 仅限该轮生命周期；本接口的任何实现不得把 env 内容写入日志或事件。
 */
export interface AdapterTurnContext {
  /** 项目工作目录（Agent 的执行根；权限层的路径裁决以此为基准）。 */
  readonly cwd: string;
  /** 本轮提示词（任务合同渲染文本或用户消息）。 */
  readonly prompt: string;
  /** Run 级注入环境变量（API 密钥等）。 */
  readonly env?: Readonly<Record<string, string>>;
  /** 指定模型；缺席 = 用 Runtime/Profile 默认。 */
  readonly model?: ModelId;
  /**
   * 本轮运行时配置覆盖（键值）。语义由具体 Runtime 定义、其余 Runtime 忽略——
   * 与 env 同款"通用通道、按 Runtime 解释"的模式（宿主在 desktop 侧按 runtime+provider 解析）。
   * codex：映射为 `-c key=value`（值按 TOML 解析，字符串需自带引号），用于把
   * openai_compatible Provider 装配成 codex 的 model_provider 路由（base_url + env_key）。
   */
  readonly configOverrides?: Readonly<Record<string, string>>;
  /**
   * 本轮要挂给 Agent 的 MCP 服务端（键 = 注册名）。与 env / configOverrides 同款
   * 「通用通道、按 Runtime 解释」：codex 映射为 per-launch `-c mcp_servers.*` 覆盖，
   * claude-code 映射为逐轮临时 `--mcp-config` 文件，其余 Runtime 忽略。
   *
   * 两条纪律，各适配器实现时必须遵守：
   * 1. **绝不改写用户的全局 MCP 配置**（codex 的 `~/.codex/config.toml`、claude 的
   *    `~/.claude.json`）。注入一律是逐轮、进程级、用完即散——用户的配置不该因为
   *    在本产品里跑过一轮而发生任何持久变化。
   * 2. **注入以注册名为隔离单位**，只影响同名条目。
   */
  readonly mcpServers?: Readonly<Record<string, McpStdioServerSpec>>;
  /**
   * 是否让 Agent 同时保留它自己配置的 MCP 服务端（缺省 false = 本轮只挂上面这些）。
   *
   * 缺省排他不是为了"干净"，而是权限层的完整性：§7 的信封拦的是子进程的文件与命令，
   * 而 MCP 工具在 CLI 内部直接执行，完全不经过拦截路径。放任用户的任意 MCP 服务端
   * 进入一轮受管执行，等于在权限信封上开了一个它看不见的口子。用户明确要这么做时
   * 才打开（设置项），并且要知道那些工具不受信封约束。
   */
  readonly inheritUserMcpServers?: boolean;
  /**
   * 原生会话恢复绑定；缺席 = 开新会话。
   * cwd 不一致的绑定是非法输入（claude resume 严格绑定 cwd），
   * 适配器应在启动前校验并快速失败，而不是让 CLI 报出难懂的错误。
   */
  readonly resume?: NativeSessionBinding;
  /** 本轮超时毫秒（到期树杀，事件流以 end 收尾）。缺省不限时。 */
  readonly timeoutMs?: number;
}

/**
 * 进行中的一轮。
 *
 * events 消费约定：单消费者 for-await；**流保证以恰好一条 end 事件收尾**——
 * Runtime 自己报了终止事件则透传映射，进程死了没报（强杀/崩溃）则由适配器
 * 按"进程退出兜底"合成（cancelled / crashed，见 events/types.ts 的 EndEvent 注释）。
 * 消费方据此无需再看进程句柄。
 */
export interface AdapterTurn {
  /** 统一事件流。 */
  readonly events: AsyncIterable<AgentEvent>;
  /**
   * 回复权限请求（nativeRequestId 来自 PermissionRequestEvent）。
   * 仅 capabilities().permissionForwarding !== "no" 的适配器实现。
   */
  respondPermission?(nativeRequestId: string, decision: PermissionDecision): Promise<void>;
  /**
   * 取消本轮：优雅协议优先（claude interrupt / opencode abort），
   * 超时或无协议则树杀（W2.1a killProcessTree）。幂等；取消后 events
   * 仍会以 end(reason: "cancelled") 正常收尾。
   */
  cancel(): Promise<void>;
}

/** Runtime 适配器：每个 Runtime 一份实现（W2.2~W2.6）。 */
export interface AgentAdapter {
  /** 注册键（KNOWN_RUNTIMES 之一；自定义远程适配器可用开放字符串）。 */
  readonly runtime: RuntimeId;
  /** 界面显示名。 */
  readonly displayName: string;
  /** 能力声明（六项三态，UI 与编排层据此决定行为，见 events/types.ts）。 */
  capabilities(): AdapterCapabilities;
  /** 开启一轮。同步返回句柄（内部 spawn 是同步的，W2.1a），失败经事件流表达。 */
  startTurn(ctx: AdapterTurnContext): AdapterTurn;
}

/** 重复注册是装配 bug，快速失败。 */
export class AdapterRegistryError extends Error {
  override readonly name = "AdapterRegistryError";
}

/** 适配器注册表：宿主（主进程）装配时注册，编排层按 runtime 取用。 */
export interface AdapterRegistry {
  register(adapter: AgentAdapter): void;
  get(runtime: RuntimeId): AgentAdapter | undefined;
  /** 已注册适配器（按 runtime 字典序，稳定可遍历）。 */
  list(): readonly AgentAdapter[];
}

/** 创建空注册表。 */
export function createAdapterRegistry(): AdapterRegistry {
  const byRuntime = new Map<string, AgentAdapter>();
  return {
    register(adapter: AgentAdapter): void {
      if (byRuntime.has(adapter.runtime)) {
        throw new AdapterRegistryError(`Runtime「${adapter.runtime}」已注册，重复注册是装配错误`);
      }
      byRuntime.set(adapter.runtime, adapter);
    },
    get(runtime: RuntimeId): AgentAdapter | undefined {
      return byRuntime.get(runtime);
    },
    list(): readonly AgentAdapter[] {
      return [...byRuntime.values()].sort((a, b) => a.runtime.localeCompare(b.runtime));
    },
  };
}
