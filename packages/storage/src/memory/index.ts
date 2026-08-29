/**
 * 项目记忆读写层（W1.2c）barrel：受控 frontmatter 编解码（类别无关，Phase 5
 * 习惯记忆复用）、条目文件编解码、落位/移动 API、state 快照。
 * Markdown 是真实数据源（设计文档 §8.4）；W1.3b 索引同步从 listEntries 重建。
 */

export * from "./entry-file.js";
export * from "./errors.js";
export * from "./frontmatter.js";
export * from "./store.js";
