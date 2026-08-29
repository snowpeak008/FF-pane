/**
 * 模型用途（kind）推断（W1.5c）。
 */

import type { ModelKind } from "@ff-pane/shared";

/**
 * kind 推断策略（W1.5c 决策，工单允许上层修改）：
 * 模型 id 小写化后包含 "embed" 判为 embedding——覆盖主流命名
 * （text-embedding-3-small、embed-english-v3、bge-embed、nomic-embed-text），
 * 其余一律 chat。这只是接口拉取时的初始标注，误判由设置页（W3.2a）手动改 kind 纠正。
 */
export function inferModelKind(modelId: string): ModelKind {
  return modelId.toLowerCase().includes("embed") ? "embedding" : "chat";
}
