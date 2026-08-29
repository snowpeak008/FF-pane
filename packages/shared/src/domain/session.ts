/**
 * 会话登记（设计文档 §10.2 规则 3、§10.3、§11.2）。
 * 会话原始记录归 Agent 自己，工作台只登记 Native Session ID 用于原生恢复，
 * 不复制会话内容。
 */

import type { EpochMillis, LocalSessionId, NativeSessionId, ProfileId } from "./common.js";
import { createLiteralGuard } from "./common.js";
import type { Role } from "./profile.js";

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
  /** 设计文档 §11.2 —— 会话角色（状态条第一项）。 */
  readonly role: Role;
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
