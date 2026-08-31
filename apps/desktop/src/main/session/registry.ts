/**
 * 桌面适配器注册表装配（T4.2）。
 *
 * 主进程持有唯一注册表，编排层按 Profile.runtime 取用（adapter.ts）。
 * M1 注册三家零参构造的 L1 stdio 适配器（Codex / Claude Code / Gemini CLI）——
 * 它们凭 env 注入的密钥即可运行，最贴合 M1 的常见配置。
 * T7.3 增补 Grok Build：同样零参可构造（凭 `XAI_API_KEY` 或用户已有的 `grok login` 登录态），
 * 故并入默认注册。
 * T7.3b 增补 Aider：零参可构造，凭 env 注入的 `OPENAI_API_KEY` 运行。它没有 cli_login
 * 登录态可退（aider.md §5.2），故密钥缺席时适配器会在 spawn 前快速失败——
 * 这是刻意的：缺密钥的 aider 会唤起浏览器做 OAuth（§7.3 坑 1）。
 *
 * OpenCode（需常驻 server + close 生命周期）与 generic-exec（需 Profile 携带命令
 * 配置）暂不默认注册，留待各自工单：前者要在 app 退出时收敛 server，后者的注册键
 * 与多实例装配需先定规约（见 docs/开发进度.md 技术债登记）。
 */

import {
  type AdapterRegistry,
  createAdapterRegistry,
  createAiderAdapter,
  createClaudeCodeAdapter,
  createCodexAdapter,
  createGeminiCliAdapter,
  createGrokBuildAdapter,
} from "@ff-pane/adapters";

/** 装配并返回桌面主进程的适配器注册表。 */
export function createDesktopAdapterRegistry(): AdapterRegistry {
  const registry = createAdapterRegistry();
  registry.register(createCodexAdapter());
  registry.register(createClaudeCodeAdapter());
  registry.register(createGeminiCliAdapter());
  registry.register(createGrokBuildAdapter());
  registry.register(createAiderAdapter());
  return registry;
}
