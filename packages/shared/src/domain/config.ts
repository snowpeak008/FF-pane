/**
 * 全局设置（设计文档 §10.1 config.json 的领域形态）。
 * 界面语言 / 主题当前由渲染层 localStorage 承载（分阶段迁移，见 i18n/theme 注释）；
 * 本类型只收「主进程也要读」的设置：AI 输出语言全局默认（Prompt 组装 T4.1 消费）、
 * 默认权限预设（新建 Profile 的起点，§7）。
 */

import type { AiOutputLanguage } from "./language.js";
import type { PermissionEnvelope } from "./permission.js";

/**
 * 设计文档 §8.3.5 路径二 —— Agent 只读知识库检索工具的 MCP 接入设置。
 *
 * **传输恒为 stdio，没有监听地址、不占端口、不发一个字节网络流量**——这不是省事，
 * 而是本工具的安全前提：进程间管道天然不经过网络栈，因此与用户的 VPN、系统代理、
 * 防火墙规则完全无关，也不可能被其他机器连上。所谓"地址可配"在 stdio 语境下就是
 * 这里的 command/args/env（与被参考项目的 McpServerConfig 同形），缺省用应用内置的
 * sidecar，用户要换成自己的实现或换个解释器时覆盖即可。
 *
 * 全部字段可缺省：整个对象缺省 = 全用内置默认。
 */
export interface KnowledgeToolSettings {
  /**
   * MCP 服务端可执行文件；缺省 = 应用自身（Electron 以 ELECTRON_RUN_AS_NODE 跑内置 sidecar）。
   * 指定它即完全接管启动方式，args 也应一并给出。
   */
  readonly command?: string;
  /** 启动参数；缺省 = 内置 sidecar 的参数。仅在 command 指定时才有意义单独覆盖。 */
  readonly args?: readonly string[];
  /** 追加到 MCP 服务端进程的环境变量（与内置注入项合并，同名以本表为准）。 */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * 在 Agent 侧注册的 MCP 服务器名，缺省 {@link DEFAULT_KNOWLEDGE_TOOL_SERVER_NAME}。
   * 名字是隔离单位：注入与清理都只认这个名，故与用户已有的 MCP 服务器同名会互相覆盖，
   * 取一个不像通用词的默认值即为此。
   */
  readonly serverName?: string;
}

/** 全局设置（config.json 的领域形态）。 */
export interface GlobalConfig {
  /** 设计文档 §9.2 —— AI 输出语言的全局默认（Profile / 项目可覆盖）。 */
  readonly aiOutputLanguage: AiOutputLanguage;
  /** 设计文档 §7 / §4.4 —— 新建 Profile 时预填的默认权限信封。 */
  readonly defaultPermissionPreset: PermissionEnvelope;
  /** 设计文档 §8.3.5 —— 只读检索工具的 MCP 接入设置；缺省 = 全用内置默认。 */
  readonly knowledgeTool?: KnowledgeToolSettings;
}

/** AI 输出语言的出厂默认（产品中文优先）。 */
export const DEFAULT_AI_OUTPUT_LANGUAGE: AiOutputLanguage = "zh-CN";

/**
 * 内置 MCP 服务器的默认注册名。带产品前缀而非叫 "knowledge"：注入以名字为键，
 * 通用词极可能与用户已配的同名服务器相撞，撞上就是静默互相覆盖。
 */
export const DEFAULT_KNOWLEDGE_TOOL_SERVER_NAME = "ffpane-knowledge";

/**
 * 只读检索工具暴露的唯一工具名。**工具面只有这一个，且只读**——
 * 写入/修改/删除知识库的工具在服务端物理不存在（§8.3.5「Agent 永远不能写入」），
 * 因此不需要、也不存在任何"要不要放行写操作"的判断分支。
 */
export const KNOWLEDGE_TOOL_NAME = "knowledge_search";

/**
 * 默认权限预设（出厂）：保守起点——项目内可读、不可写、禁 Shell、禁网络、
 * 危险操作恒需逐次确认。用户在设置页 / Profile 里按需放宽。
 */
export const DEFAULT_PERMISSION_PRESET: PermissionEnvelope = {
  readPaths: ["**"],
  writePaths: [],
  shell: "forbidden",
  network: false,
  // 类型固定为 true：任何信封都不能关闭危险操作确认（§7 第 5 项）
  dangerousOpsRequireApproval: true,
};

/** 出厂默认全局设置（config.json 不存在时的回退值）。 */
export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  aiOutputLanguage: DEFAULT_AI_OUTPUT_LANGUAGE,
  defaultPermissionPreset: DEFAULT_PERMISSION_PRESET,
};
