/**
 * 会话登记与对话回放本（设计文档 §10.2 规则 3、§10.3、§11.2）。
 *
 * Agent 自己的会话文件仍归 Agent，工作台登记 Native Session ID 用于原生恢复；
 * 自 T8.2b（设计文档 2026-09-02 修订）起，工作台另维护一份 **text-only 的对话回放本**
 * （TranscriptEntry）：只记用户提示词、assistant 文本与轮次元数据，不记工具事件 / diff
 * （归 Run）、不记任何密钥。
 */

import type {
  EpochMillis,
  LocalSessionId,
  NativeSessionId,
  ProfileId,
  RunId,
  TaskId,
} from "./common.js";
import { createLiteralGuard } from "./common.js";
import type { RoleRef } from "./profile.js";
import type { RunEndReason } from "./run.js";

/**
 * 设计文档 §10.3 —— 会话恢复三分法（§11.2 状态条的"会话类型"标注）：
 * native 原生恢复（同 Agent + 支持原生恢复）；
 * context_rebuild 上下文重建（同 Agent + 不支持原生恢复）;
 * handoff 跨 Agent 迁移（换 Agent，经 §10.4 交接包）。
 */
export const SESSION_RESUME_KINDS = ["native", "context_rebuild", "handoff"] as const;

/** 设计文档 §10.3 —— 会话恢复方式。 */
export type SessionResumeKind = (typeof SESSION_RESUME_KINDS)[number];

/** SessionResumeKind 运行时守卫。 */
export const isSessionResumeKind = createLiteralGuard(SESSION_RESUME_KINDS);

/**
 * 设计文档 §10.2 规则 3 —— 原生会话绑定：Native Session ID 与 cwd 成对登记。
 * T2.0 调研实证（docs/adapters/claude-code.md §4）：Claude Code 的 resume
 * 严格绑定 cwd，跨目录 resume 同一 ID 会失败——恢复时必须用登记的同一 cwd
 * 启动子进程。其他 Runtime 一律沿用成对登记，不做特例。
 */
export interface NativeSessionBinding {
  /** 设计文档 §10.2 规则 3 —— Runtime 原生会话 ID。 */
  readonly nativeSessionId: NativeSessionId;
  /** T2.0 —— 该原生会话绑定的工作目录（resume 的 key 之一）。 */
  readonly cwd: string;
}

/**
 * 设计文档 §10.2 规则 3 / §10.3 —— 会话登记记录（项目内）。
 * Local Session ID 是工作台自身的会话标识；原生会话绑定仅当 Runtime 支持
 * 原生恢复且已收到原生会话 ID 时登记。
 */
export interface SessionRecord {
  /** 工作台本地会话 ID。 */
  readonly id: LocalSessionId;
  /** 设计文档 §11.2 —— 会话由哪个 Profile 承载（状态条显示 Profile 名/模型）。 */
  readonly profileId: ProfileId;
  /** 设计文档 §11.2 —— 会话角色（状态条第一项；T8.4 起可为自定义角色 ID）。 */
  readonly role: RoleRef;
  /** 设计文档 §10.2 规则 3 —— 原生会话绑定（Runtime 不支持原生恢复时缺省）。 */
  readonly native?: NativeSessionBinding;
  /**
   * 设计文档 §10.3 / §11.2 —— 本会话的开始方式标注：
   * 缺省 = 全新会话；否则为三种恢复方式之一（原生/重建/迁移）。
   */
  readonly resumeKind?: SessionResumeKind;
  /** 会话创建时间（epoch 毫秒）。 */
  readonly createdAt: EpochMillis;
  /** 最近活动时间（epoch 毫秒；§11.1 项目卡片"最后活动时间"的数据来源之一）。 */
  readonly lastActiveAt: EpochMillis;
}

// ── 对话回放本（T8.2b，设计文档 §10.2 规则 3 修订版）────────────────────────

/** 对话回放本条目类别（判别字段 kind 的取值全集）。 */
export const TRANSCRIPT_ENTRY_KINDS = ["user_message", "assistant_message", "turn_end"] as const;

/** 对话回放本条目类别。 */
export type TranscriptEntryKind = (typeof TRANSCRIPT_ENTRY_KINDS)[number];

/** TranscriptEntryKind 运行时守卫。 */
export const isTranscriptEntryKind = createLiteralGuard(TRANSCRIPT_ENTRY_KINDS);

/**
 * 用户在某一轮的提示词——**只记用户可见的原始输入**：Planner 讨论轮 / 计划生成轮是
 * 用户敲的那段话；Worker 轮 / 审查轮是任务合同的目标一句（合同本身在任务页可见），
 * 不记系统提示、不记注入的记忆 / 习惯 / 重建 / 交接文本（那些是工作台拼上去的，回放
 * 时把它们显示成"用户说的"会误导）。
 */
export interface TranscriptUserMessage {
  readonly kind: "user_message";
  /** 所属轮次（与 session:event 的 turnId 同源，供界面把消息与轮次对齐）。 */
  readonly turnId: string;
  /** 写入时刻（epoch 毫秒）。 */
  readonly at: EpochMillis;
  /** 用户可见的原始输入文本。 */
  readonly text: string;
  /** Worker / 审查轮：本轮针对的任务（界面据此渲染「派发任务 X」而不是靠猜）。 */
  readonly taskId?: TaskId;
  /** 审查轮：被审查的那条 Run。 */
  readonly runId?: RunId;
}

/**
 * assistant 在某一轮的答复文本（answer 通道全文；reasoning 不记）。
 * `partial: true` = 轮次被中断时抢救下来的部分文本（工作台退出 / 崩溃），非完整答复。
 */
export interface TranscriptAssistantMessage {
  readonly kind: "assistant_message";
  readonly turnId: string;
  readonly at: EpochMillis;
  readonly text: string;
  /** 仅在文本不完整（轮次被中断）时为 true；完整答复缺省该字段。 */
  readonly partial?: true;
}

/**
 * 一轮的收尾元数据。每轮恰好一条，无论完成 / 失败 / 取消 / 崩溃 / 中断——
 * 回放时它是"这一轮结束了、怎么结束的"的唯一依据，也是续接横幅判断
 * 「上一轮是否被中断」的依据。
 */
export interface TranscriptTurnEnd {
  readonly kind: "turn_end";
  readonly turnId: string;
  readonly at: EpochMillis;
  /** 本轮角色（T8.4 起可为自定义角色 ID；旧数据只含内置三字面量，向后兼容）。 */
  readonly role: RoleRef;
  /** 承载本轮的 Profile。 */
  readonly profileId: ProfileId;
  /**
   * 本轮的恢复方式（首轮缺省）。刻意记在每轮而不只记在会话登记上：grok-build / aider
   * 的原生会话 ID 只在流末尾才到，首轮被中断的会话此后只能 context_rebuild——
   * 逐轮记录才能让界面如实标注"这一轮是重建续上的"。
   */
  readonly resumeKind?: SessionResumeKind;
  /** Worker 轮铸出的 Run / 审查轮被审的 Run（Planner 轮缺省）。 */
  readonly runId?: RunId;
  /** Worker / 审查轮针对的任务（Planner 轮缺省）。 */
  readonly taskId?: TaskId;
  /** 结束原因（与 Run.endReason 同一取值集；Planner 轮同样如实记）。 */
  readonly endReason: RunEndReason;
}

/** 对话回放本条目（按 kind 判别）。 */
export type TranscriptEntry =
  | TranscriptUserMessage
  | TranscriptAssistantMessage
  | TranscriptTurnEnd;

/**
 * 在飞轮次标记（T8.2b）：轮开始时落盘、正常收尾时删除。工作台退出 / 崩溃后残留的
 * 标记就是"上次有哪些轮被中断"的证据，启动修正据此补 Run(interrupted)、把任务从
 * running 拉回 failed、给 transcript 补 turn_end。
 */
export interface InflightTurnMarker {
  readonly turnId: string;
  /** 所属本地会话（定位 transcript 文件）。 */
  readonly sessionId: LocalSessionId;
  readonly role: RoleRef;
  readonly profileId: ProfileId;
  /** 轮开始时刻（epoch 毫秒；补写 Run 时作为 startedAt）。 */
  readonly startedAt: EpochMillis;
  /** 本轮的恢复方式（首轮缺省；补写 turn_end 时沿用）。 */
  readonly resumeKind?: SessionResumeKind;
  /** Worker 轮：被派发的任务（修正时据此补 Run 并推进任务状态）。 */
  readonly taskId?: TaskId;
  /** 审查轮：被审查的那条 Run（修正时只补 turn_end，不铸新 Run）。 */
  readonly runId?: RunId;
}
