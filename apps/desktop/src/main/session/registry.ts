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
 * ## 多实例注册键规约（T8.3a 定稿；装配实现归 T8.3b，本文件暂不改代码）
 *
 * **按 Profile 逐实例化，注册键为 `<runtime>@<profileId>` 复合键**（如
 * `generic-exec@prof-abc`）；无构造期配置的适配器（codex / claude-code / gemini-cli /
 * grok-build）维持裸 runtime 键单例不变。规则：
 * 1. 编排层取用时先查 `<profile.runtime>@<profile.id>`，未命中再退回裸
 *    `profile.runtime`——零配置适配器一行不改，带配置适配器按 Profile 命中专属实例；
 * 2. 复合键实例由装配层在 Profile 创建 / 更新时懒构造并缓存，Profile 删除时随之
 *    注销（AdapterRegistry 已按键唯一、重复注册抛错，天然挡住重复装配）；
 * 3. `KNOWN_RUNTIMES` 与 `Profile.runtime` 的取值不变（仍是裸 runtime）——复合键
 *    是注册表内部寻址方案，不进领域模型、不进 UI 下拉框。
 * 两案对比（决策依据，调研后维持主管理员方向）：
 * - 案 A（选定）按 Profile 逐实例化：Profile 本就是「runtime + 配置」的既有聚合根
 *   （generic-exec 的命令模板、aider 的 tempDir 都随 Profile 走），无需新增“工具实例”
 *   实体与其 CRUD / 存储 / UI；同一 CLI 想配两套参数 = 建两个 Profile，与用户心智一致。
 *   代价：两个 Profile 配置完全相同也会各持一个实例——但适配器实例只是轻量闭包
 *   （无常驻进程，spawn 发生在 startTurn），重复实例无实际成本。
 * - 案 B 独立“工具实例”注册（键 = 用户命名的实例 ID，Profile 引用实例）：可跨 Profile
 *   复用同一配置，但要新增一层实体 + 存储 + 设置页管理 + Profile 迁移，而“复用配置”
 *   在 Profile 数量个位数的现实下收益趋零。复杂度不成比例，弃。
 *
 * **aider tempDir 候选②在本规约下的可行性结论（T8.3a 只写结论不实现）**：可行。
 * 按 Profile 实例化后 `createAiderAdapter({ tempDir })` 的构造期选项有了落点，但
 * tempDir 仍是**适配器级**（跨项目共用），做不到合同想要的
 * `<项目>/.workbench/sessions/<localSessionId>/`（那是**轮次级**信息，须走
 * AdapterTurnContext 加字段，即候选①，改适配器接口）。故候选②落地形态为
 * `~/.aiworkbench/agent-sessions/<profileId>/`（出 tmpdir、随 Profile 隔离、寿命可控），
 * 归 T8.3b 装配时一并接线；是否连带做候选①由届时另行裁定。
 *
 * OpenCode（需常驻 server + close 生命周期）暂不默认注册，留待其工单：
 * 要在 app 退出时收敛 server。
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
