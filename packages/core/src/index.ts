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
