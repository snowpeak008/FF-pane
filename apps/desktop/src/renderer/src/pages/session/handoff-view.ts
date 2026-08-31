/**
 * 跨 Agent 迁移的纯视图逻辑（T7.1，设计文档 §10.4）。
 *
 * 与 React 无关，便于单测。本文件不含任何面向用户的文案——措辞一律由调用方经语言包取。
 */

import type { AgentProfile, ProfileId } from "@ff-pane/shared";

/** 迁移目标候选：Profile + 它相对当前 Profile 是否换了 Runtime。 */
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
}

/**
 * 派生迁移目标列表：排除当前 Profile 自己（迁移到自己没有意义——那是普通续接），
 * 并标出哪些换了 Runtime。顺序沿用 profiles:list（用户在设置页看到的顺序）。
 */
export function deriveHandoffTargets(
  profiles: readonly AgentProfile[],
  current: AgentProfile | null,
): readonly HandoffTarget[] {
  return profiles
    .filter((profile) => profile.id !== current?.id)
    .map((profile) => ({
      profile,
      runtimeChanged: current !== null && profile.runtime !== current.runtime,
    }));
}

/**
 * 挑一个缺省选中的目标：优先换了 Runtime 的第一个（"换 Agent"最典型的一次），
 * 没有就取第一个；一个候选都没有时返回 undefined（界面据此提示用户先去建 Profile）。
 */
export function defaultHandoffTargetId(targets: readonly HandoffTarget[]): ProfileId | undefined {
  const preferred = targets.find((target) => target.runtimeChanged) ?? targets[0];
  return preferred?.profile.id;
}
