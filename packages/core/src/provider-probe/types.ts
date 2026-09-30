/**
 * Provider 连接探测的公共类型（W1.5c / T10.3：按模板 probe kind 分发）。
 */

/// <reference types="node" />

import type {
  ModelId,
  ProviderModel,
  ProviderProbeKind,
  ProviderTemplateId,
} from "@ff-pane/shared";

/**
 * 探测失败的阶段。
 */
export type ProbeFailureStage =
  | "unsupported"
  | "invalid-config"
  | "network"
  | "timeout"
  | "http"
  | "invalid-response";

/** 探测失败结果。 */
export interface ProbeFailure {
  readonly ok: false;
  readonly stage: ProbeFailureStage;
  readonly rawError: string;
}

/**
 * 探测所需的最小 Provider 字段子集。
 * T10.3：以 templateId / probe 为准；完整 Provider 可直接传入。
 */
export interface ProbeProviderInput {
  /** 模板 ID（优先据此查 probe kind）。 */
  readonly templateId?: ProviderTemplateId | string;
  /** 显式探测方式（表单未存盘时可由 UI 按所选模板填入）。 */
  readonly probe?: ProviderProbeKind;
  readonly baseUrl?: string;
  readonly timeoutS?: number;
  /** 默认对话模型（兼容旧字段名 defaultModel）。 */
  readonly defaultModelId?: ModelId;
  readonly defaultModel?: ModelId;
}

export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface FetchModelsParams {
  readonly provider: ProbeProviderInput;
  readonly apiKey?: string;
  readonly fetchImpl?: ProbeFetch;
}

export interface TestConnectionParams extends FetchModelsParams {
  readonly model?: ModelId;
}

export interface ConnectionTestSuccess {
  readonly ok: true;
  readonly latencyMs: number;
  readonly detail: string;
}

export type ConnectionTestResult = ConnectionTestSuccess | ProbeFailure;

export interface FetchModelsSuccess {
  readonly ok: true;
  readonly models: readonly ProviderModel[];
}

export type FetchModelsResult = FetchModelsSuccess | ProbeFailure;
