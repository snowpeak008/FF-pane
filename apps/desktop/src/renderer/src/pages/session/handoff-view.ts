/**
 * 跨 Agent 迁移 /「开新会话并继承」的纯视图逻辑（T7.1 → T9.8 ①，设计文档 §10.4）。
 *
 * 与 React 无关，便于单测。本文件不含任何面向用户的文案——措辞一律由调用方经语言包取。
 */

import type { AgentProfile, ProfileId } from "@ff-pane/shared";

/** 迁移目标候选：Profile + 它相对当前 Profile 的差异标注。 */
export interface HandoffTarget {
  readonly profile: AgentProfile;
  /**
   * 相对当前 Profile 是否换了 Runtime。
   * 换 Runtime = 真的换了一个 Agent（codex → claude-code），交接包是唯一的接续途径；
   * 同 Runtime 换 Provider/模型也是一次值得交接的迁移（原生会话绑在旧进程的会话文件上，
   * 换了模型未必续得上，且用户就是想让新配置"从头带着上下文开始"），故**两者都放行**，
   * 只把差异标出来让用户自己判断。
   */
  readonly runtimeChanged: boolean;
  /**
   * 就是当前 Profile 自己（T9.8 ①）。选它 = 同 Profile「轻装新开」：交接包管线不变、
   * 编排器照样强制开新会话，只是接收方还是自己——旧会话的膨胀上下文不再跟随。
   */
  readonly isCurrent: boolean;
}

/**
 * 派生迁移目标列表：**含当前 Profile 自己**（T9.8 ① 放开——迁移到自己即「同 Profile
 * 轻装新开」，是应对上下文膨胀的正路），并标出哪些换了 Runtime、哪个是自己。
 * 顺序沿用 profiles:list（用户在设置页看到的顺序）。
 */
export function deriveHandoffTargets(
  profiles: readonly AgentProfile[],
  current: AgentProfile | null,
): readonly HandoffTarget[] {
  return profiles.map((profile) => {
    const isCurrent = current !== null && profile.id === current.id;
    return {
      profile,
      runtimeChanged: current !== null && !isCurrent && profile.runtime !== current.runtime,
      isCurrent,
    };
  });
}

/**
 * 「换 Agent」意图的缺省选中：优先换了 Runtime 的第一个（"换 Agent"最典型的一次），
 * 其次第一个非自己的候选，实在只剩自己就选自己（轻装新开也成立）；
 * 一个候选都没有时返回 undefined（界面据此提示用户先去建 Profile）。
 */
export function defaultHandoffTargetId(targets: readonly HandoffTarget[]): ProfileId | undefined {
  const preferred =
    targets.find((target) => target.runtimeChanged) ??
    targets.find((target) => !target.isCurrent) ??
    targets[0];
  return preferred?.profile.id;
}

/**
 * 「开新会话并继承」意图的缺省选中（T9.8 ①）：优先当前 Profile 自己——轻装新开的
 * 常态是"还是这个 Agent，只是甩掉膨胀的上下文"；没有当前 Profile（未绑定）时退回
 * 换 Agent 的缺省逻辑。
 */
export function defaultInheritTargetId(targets: readonly HandoffTarget[]): ProfileId | undefined {
  return targets.find((target) => target.isCurrent)?.profile.id ?? defaultHandoffTargetId(targets);
}
