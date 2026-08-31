/**
 * 跨 Agent 交接包（T7.1，设计文档 §10.4）barrel：8 字段组装 + 文本渲染。
 * 同 Agent 续接（native / context_rebuild）归 ./resume，两者不共用代码——
 * 续接是"你自己的历史"，交接是"别人的项目现状"，措辞与取材边界都不同。
 */

export * from "./build.js";
export * from "./render.js";
