/**
 * 习惯（共享记忆）读写层（T5.1）barrel：条目文件编解码（复用 memory 的
 * frontmatter 子集）、草稿校验、落位/移动/启用 API。全局作用域（§8.2 / §10.1）。
 * Markdown 是真实数据源；冲突检测（相近条目并排）属 core（@ff-pane/core habit）。
 */

export * from "./errors.js";
export * from "./habit-file.js";
export * from "./observations.js";
export * from "./store.js";
export * from "./validate.js";
