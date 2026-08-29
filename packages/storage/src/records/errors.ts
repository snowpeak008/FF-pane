/**
 * records 层错误类型（W1.2b）：沿用 W1.2a fs 错误族的「Error 子类 + code 字面量
 * 判别字段」模式。
 *
 * 新错误码 invalid-record 不并入 StorageFsError 的闭合 code 联合——字段级校验失败
 * （状态字面量非法、版本 / ID 与文件名不一致等）是数据内容问题而非文件系统故障，
 * 且 W1.2a 的错误码全集已定稿；records 自持错误类型，与 fs 错误族在结果联合中并列，
 * 调用方仍统一用 error.code 做穷尽分支。
 */

import type { ReadJsonError } from "../fs/index.js";

/** records 记录层错误码（判别字段的取值全集）。 */
export const STORAGE_RECORD_ERROR_CODES = ["invalid-record"] as const;

/** records 记录层错误码。 */
export type StorageRecordErrorCode = (typeof STORAGE_RECORD_ERROR_CODES)[number];

/**
 * 记录字段校验失败：文件能读、JSON 能解析，但字段值非法（如手工编辑引入的
 * 未知状态字面量）。错误信息携带文件路径与字段名（开发计划 §1.4 红线 3：
 * 系统边界失败路径必须可理解）。
 */
export class StorageInvalidRecordError extends Error {
  /** 判别字段：与 StorageFsError 各子类的 code 并列参与联合收窄。 */
  readonly code = "invalid-record" as const;
  /** 出错的数据文件路径。 */
  readonly path: string;
  /** 非法字段名（如 "status"、"version"、"rawLogPath"）。 */
  readonly field: string;

  constructor(path: string, field: string, reason: string) {
    super(`字段 ${field} 非法（${reason}）: ${path}`);
    this.name = new.target.name;
    this.path = path;
    this.field = field;
  }
}

/** records 读取类 API 的失败集合：fs 层读取失败 ∪ 字段校验失败。 */
export type RecordLoadError = ReadJsonError | StorageInvalidRecordError;

/**
 * records 读取类 API 的判别联合结果。与 fs 层 FsResult 同构（ok / value / error），
 * 但错误位允许 StorageInvalidRecordError（其不属于 StorageFsError 族，见模块注释）。
 */
export type RecordResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: RecordLoadError };

/** 计划视图（.md）异常的警告码：视图缺失 / 视图读取失败。视图问题不阻塞读取。 */
export const PLAN_VIEW_WARNING_CODES = ["plan-md-missing", "plan-md-unreadable"] as const;

/** 计划视图警告码。 */
export type PlanViewWarningCode = (typeof PLAN_VIEW_WARNING_CODES)[number];

/**
 * 计划视图警告：loadPlan 校验 plan-v<N>.md 存在性时产生。
 * md 只是渲染视图（权威数据在 meta.json，见 ./plan.ts 模块注释），
 * 缺失或不可读仅警告不阻塞，调用方可提示用户重新 savePlan 补齐视图。
 */
export interface PlanViewWarning {
  readonly code: PlanViewWarningCode;
  /** 出问题的 .md 文件路径。 */
  readonly path: string;
  /** 人类可读的警告说明。 */
  readonly message: string;
}
