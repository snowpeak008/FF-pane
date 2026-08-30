/**
 * 会话恢复方式判定（T4.3，设计文档 §10.3 会话恢复三分法）。
 *
 * 三分法：native 原生恢复 / context_rebuild 上下文重建 / handoff 跨 Agent 迁移。
 * 本函数只裁决**同 Agent** 续接下的前两者；handoff（换 Agent，§10.4 交接包）归 Phase 7。
 *
 * 纯逻辑、零依赖：入参是已归一的布尔判据（cwd 匹配、Runtime 是否支持原生恢复、
 * 是否登记了原生绑定），故与 @ff-pane/adapters 的能力类型解耦——宿主编排层把
 * `capabilities().nativeResume === "yes"` 折算为 supportsNativeResume 传入。
 */

/** decideResumeKind 的判据（全部由编排层从会话登记 + 适配器能力归一）。 */
export interface ResumeDecisionInput {
  /** 会话登记里是否有原生会话绑定（NativeSessionBinding）。 */
  readonly hasNativeBinding: boolean;
  /**
   * 绑定的 cwd 是否与本次启动的项目工作目录一致。
   * 设计文档 §10.2 规则 3：原生恢复严格绑定 cwd，不一致则原生恢复必失败。
   */
  readonly bindingCwdMatches: boolean;
  /** 该 Runtime 是否支持原生会话恢复（capabilities().nativeResume === "yes"）。 */
  readonly supportsNativeResume: boolean;
}

/**
 * 判定同 Agent 续接的恢复方式：三项判据全真才走 native，否则退化为 context_rebuild。
 * 退化是安全兜底而非缺陷：上下文重建用登记的计划/任务/state/Run 报告重建上下文，
 * 任何 Runtime 都可用，故"续接不上原生会话"绝不等于"无法继续"。
 */
export function decideResumeKind(input: ResumeDecisionInput): "native" | "context_rebuild" {
  return input.hasNativeBinding && input.bindingCwdMatches && input.supportsNativeResume
    ? "native"
    : "context_rebuild";
}
