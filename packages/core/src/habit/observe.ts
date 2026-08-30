/**
 * 来源三：系统观察建议（T5.4，设计文档 §8.2.4）。
 *
 * 目标（用户明确的重点）：用户在**不同会话里反复用同样的话纠正 AI** 时，系统把这些
 * 同类纠正跨会话累计，达到阈值就生成一条 observed 习惯候选，提示用户确认为长期习惯——
 * 实现「越用越顺手」。红线：只产生候选，绝不自动 active（写入 active 唯一途径是用户确认）。
 *
 * 本模块是纯逻辑（判定 + 累计 + 是否达到阈值）；观察记录的持久化在 storage，候选落库与
 * 提示在 desktop 接线层。检测策略经与用户对齐：
 * - 跨会话持久累计；
 * - 阈值 4（累计 4 次相似纠正才建议）；
 * - 只把「带纠正词的祈使句」当纠正信号（宁缺毋滥，压低误报）。
 */

import type { EpochMillis, HabitObservation } from "@ff-pane/shared";
import { habitTextSimilarity } from "./conflict.js";

/**
 * 纠正/约束词表：命中其一且够短的祈使句才当作一次「纠正」。词表刻意保守，
 * 覆盖常见的流程/偏好纠正措辞，避免把普通需求（"帮我做个登录页"）误判为纠正。
 */
export const CORRECTION_MARKERS: readonly string[] = [
  "不要",
  "别",
  "先别",
  "先",
  "应该",
  "记住",
  "记得",
  "下次",
  "以后",
  "每次",
  "总是",
  "必须",
  "一定要",
  "不许",
  "不能",
  "改成",
  "而不是",
];

/** 累计几次相似纠正才生成候选（经用户确认：4 次）。 */
export const OBSERVED_SUGGEST_THRESHOLD = 4;

/** 同类纠正归并的相似度阈值（比入库相近检测更严，确保确实是"同一句纠正"）。 */
export const OBSERVATION_SIMILARITY_THRESHOLD = 0.5;

/** 判定为纠正的祈使句长度上限（纠正通常是短指令；过长多为需求描述）。 */
const CORRECTIVE_MAX_LENGTH = 80;

/** 是否是一次「纠正类」消息：够短 + 命中纠正词（§8.2.4 来源三，marker-based）。 */
export function isCorrectiveMessage(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > CORRECTIVE_MAX_LENGTH) {
    return false;
  }
  return CORRECTION_MARKERS.some((marker) => t.includes(marker));
}

/** observeCorrection 的入参。 */
export interface ObserveCorrectionInput {
  readonly observations: readonly HabitObservation[];
  readonly message: string;
  readonly now: EpochMillis;
  /** 生成新观察记录 ID（注入，保证纯函数）。 */
  readonly newId: () => string;
  readonly threshold?: number;
  readonly similarityThreshold?: number;
}

/** observeCorrection 的结果：更新后的观察集合 + （达到阈值时）一条待生成候选的建议。 */
export interface ObserveCorrectionResult {
  readonly observations: readonly HabitObservation[];
  /** 本次达到阈值、应生成候选并提示的建议（否则缺省）。 */
  readonly suggestion?: { readonly content: string; readonly count: number };
  /** 观察集合是否有变化（供上层决定是否落盘，避免无谓写入）。 */
  readonly changed: boolean;
}

/**
 * 记录一次可能的纠正并检测是否达到建议阈值（纯函数）。
 * - 非纠正消息：原样返回，changed=false。
 * - 纠正消息：归并到最相似的既有观察（≥ 相似阈值）并 count+1，否则新增一条 count=1；
 *   当该观察 count 达到阈值且尚未建议过 → 置 suggested=true 并返回 suggestion。
 */
export function observeCorrection(input: ObserveCorrectionInput): ObserveCorrectionResult {
  const threshold = input.threshold ?? OBSERVED_SUGGEST_THRESHOLD;
  const simThreshold = input.similarityThreshold ?? OBSERVATION_SIMILARITY_THRESHOLD;

  if (!isCorrectiveMessage(input.message)) {
    return { observations: input.observations, changed: false };
  }
  const message = input.message.trim();

  let bestIndex = -1;
  let bestSim = 0;
  input.observations.forEach((obs, index) => {
    const sim = habitTextSimilarity(message, obs.content);
    if (sim >= simThreshold && sim > bestSim) {
      bestSim = sim;
      bestIndex = index;
    }
  });

  let observations: HabitObservation[];
  let target: HabitObservation;
  if (bestIndex === -1) {
    target = {
      id: input.newId(),
      content: message,
      count: 1,
      firstSeenAt: input.now,
      lastSeenAt: input.now,
      suggested: false,
    };
    observations = [...input.observations, target];
  } else {
    const prev = input.observations[bestIndex] as HabitObservation;
    target = { ...prev, count: prev.count + 1, lastSeenAt: input.now };
    observations = input.observations.map((obs, index) => (index === bestIndex ? target : obs));
  }

  if (target.count >= threshold && !target.suggested) {
    observations = observations.map((obs) =>
      obs.id === target.id ? { ...obs, suggested: true } : obs,
    );
    return {
      observations,
      changed: true,
      suggestion: { content: target.content, count: target.count },
    };
  }

  return { observations, changed: true };
}
