/** Agent Runtime 适配器（codex / claude / gemini / opencode / generic-exec，T2.x 落地）。 */
/** AgentAdapter 统一接口、turn 模型与注册表（W2.1c）。 */
export * from "./adapter.js";
/** Aider 适配器（T7.3b）：纯文本 stdout 行扫描 + git 快照 diff 自补。 */
export * from "./aider/index.js";
export * from "./auth-probe/index.js";
/** Claude Code 适配器（W2.4）：stream-json 双向协议、stdio 权限转发、interrupt 优雅取消。 */
export * from "./claude-code/index.js";
/** Codex CLI 适配器（W2.3）：exec/resume 命令行、事件映射、git 快照 diff 自补。 */
export * from "./codex/index.js";
/** 统一 AgentEvent 与 JSONL 流解析（W2.1b）。splitLines 自 T0.1 起从此处导出，语义不变。 */
export * from "./events/index.js";
/** Gemini CLI 适配器（W2.5）：stream-json 映射器 + 每 Run --policy 策略生成器。 */
export * from "./gemini-cli/index.js";
/** L2 通用单次命令适配器（W2.2）：任意 CLI 一进一出的兜底接入。 */
export * from "./generic-exec/index.js";
/** Grok Build 适配器（T7.3）：headless streaming-json 映射、事件流自带 diff。 */
export * from "./grok-build/index.js";
/** 运行时权限拦截桥接（W2.7b）：把 core 的 run-guard 裁决接到真实事件流上。 */
export * from "./guard/index.js";
/** OpenCode 适配器（W2.6）：`opencode serve` + HTTP/SSE 接入路径。 */
export * from "./opencode/index.js";
/** Agent CLI 子进程管理层（W2.1a）：spawn 封装、环境变量清洗、进程树终止。 */
export * from "./process/index.js";

export const PACKAGE_NAME = "@ff-pane/adapters";
