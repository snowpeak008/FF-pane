/** Agent Runtime 适配器（codex / claude / gemini / opencode / generic-exec，T2.x 落地）。 */
/** AgentAdapter 统一接口、turn 模型与注册表（W2.1c）。 */
export * from "./adapter.js";
export * from "./auth-probe/index.js";
/** 统一 AgentEvent 与 JSONL 流解析（W2.1b）。splitLines 自 T0.1 起从此处导出，语义不变。 */
export * from "./events/index.js";
/** Agent CLI 子进程管理层（W2.1a）：spawn 封装、环境变量清洗、进程树终止。 */
export * from "./process/index.js";

export const PACKAGE_NAME = "@ff-pane/adapters";
