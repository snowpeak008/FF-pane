/**
 * 领域逻辑：Plan / Task / Run / Memory 状态机（T1.4 落地）。
 * 硬性规则：本包不得 import 任何 Electron API（技术选型 §3）。
 */
export const PACKAGE_NAME = "@ff-pane/core";

/**
 * 穷举断言：用于状态机 switch 的 default 分支，
 * 编译期保证所有状态被处理，运行期兜底抛错。
 */
export function assertNever(value: never, context = "assertNever"): never {
  throw new Error(`${context}: unexpected value ${JSON.stringify(value)}`);
}

export * from "./permission/index.js";

/** Plan 状态机（W1.4a）：迁移表、迁移函数、版本演进、typed error。 */
export * from "./plan/index.js";

/** Agent Profile 校验（W1.6）：草稿校验、预设 ⊆ 角色默认信封的合规检查。 */
export * from "./profile/index.js";

/** Provider 连接探测（W1.5c）：连接测试 + /models 拉取，纯网络逻辑、零密钥存取。 */
export * from "./provider-probe/index.js";

/** Run 权限执行层（W2.7a）：信封装配 + 写路径/命令事前裁决 + 证据事后审计。 */
export * from "./run-guard/index.js";
export * from "./task/index.js";
