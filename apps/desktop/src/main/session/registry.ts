/**
 * 桌面适配器注册表装配（T4.2）。
 *
 * 主进程持有唯一注册表，编排层按 Profile.runtime 取用（adapter.ts）。
 * M1 注册三家零参构造的 L1 stdio 适配器（Codex / Claude Code / Gemini CLI）——
 * 它们凭 env 注入的密钥即可运行，最贴合 M1 的常见配置。
 *
 * OpenCode（需常驻 server + close 生命周期）与 generic-exec（需 Profile 携带命令
 * 配置）暂不默认注册，留待各自工单：前者要在 app 退出时收敛 server，后者的注册键
 * 与多实例装配需先定规约（见 docs/开发进度.md 技术债登记）。
 */

import {
  type AdapterRegistry,
  createAdapterRegistry,
  createClaudeCodeAdapter,
  createCodexAdapter,
  createGeminiCliAdapter,
} from "@ff-pane/adapters";

/** 装配并返回桌面主进程的适配器注册表。 */
export function createDesktopAdapterRegistry(): AdapterRegistry {
  const registry = createAdapterRegistry();
  registry.register(createCodexAdapter());
  registry.register(createClaudeCodeAdapter());
  registry.register(createGeminiCliAdapter());
  return registry;
}
