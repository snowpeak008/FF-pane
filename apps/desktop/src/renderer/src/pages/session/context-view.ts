/**
 * 上下文阈值提醒的纯视图逻辑（T9.8 ②）。与 React 无关，便于单测。
 *
 * 分子（用量）双路：
 * 1. 真实 usage —— `context-usage` 事件按会话记账（codex / qwen 的 result usage、
 *    grok 的 end usage 与 ACP usage_update，各家折算口径见 adapters events/types.ts
 *    TokenUsage.contextTokens 注释）；
 * 2. 字符估算 —— 取不到真实 usage 时按转录累计字符折算 token 并标注「估算」。
 *
 * 分母（窗口）三级：Agent 自报（grok usage_update 的 size）→ 模型注册表公开规格
 * → Runtime 保守估算 / 保守默认（cli_login 缺省模型场景），后两级经 shared 的
 * resolveContextWindow；非 model/agent 来路一律标注「估算」。
 */

import { resolveContextWindow } from "@ff-pane/shared";
import type { SessionContextUsage } from "../../stores/session";

/**
 * 字符 → token 的保守折算：CJK 每字约 1 token，其余文本约 4 字符 1 token
 * （BPE 系 tokenizer 的通行近似）。刻意取偏高的估值——提醒宁可来得早，
 * 不要等真溢出了才响。
 */
export const CJK_CHARS_PER_TOKEN = 1;

/** 非 CJK 文本的每 token 字符数（通行近似）。 */
export const ASCII_CHARS_PER_TOKEN = 4;

/** CJK 统一表意文字与常用扩展区（含全角标点、假名、谚文）。 */
const CJK_PATTERN = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/gu;

/** 按转录文本估算 token（分子回退路径；见文件头折算说明）。 */
export function estimateTokensFromText(text: string): number {
  const cjkCount = text.match(CJK_PATTERN)?.length ?? 0;
  const otherCount = text.length - cjkCount;
  return Math.ceil(cjkCount / CJK_CHARS_PER_TOKEN + otherCount / ASCII_CHARS_PER_TOKEN);
}

/** 上下文用量表（横幅数据源）。 */
export interface ContextGauge {
  /** 分子：上下文占用 token 数（真实或估算）。 */
  readonly usedTokens: number;
  /** 分母：上下文窗口 token 数。 */
  readonly windowTokens: number;
  /** 用量百分比（0~100+，向下取整；可超 100——窗口真被撑爆时如实显示）。 */
  readonly percent: number;
  /**
   * 是否含估算成分（分子走字符估算，或分母非 模型公开规格 / Agent 自报）。
   * UI 据此标注「估算」——不能把猜出来的数字呈现成事实。
   */
  readonly estimated: boolean;
  /** 达到阈值，应显示「建议轻装重开」横幅。 */
  readonly shouldWarn: boolean;
}

/** deriveContextGauge 的输入。 */
export interface ContextGaugeInput {
  /** 本会话最近一轮的真实用量（无则走字符估算）。 */
  readonly usage: SessionContextUsage | undefined;
  /** 转录累计字符的载体文本（历史消息 + 在飞轮已累积文本），估算路径的输入。 */
  readonly transcriptText: string;
  /** 当前会话的模型（started 事件报出的权威值优先；可空 = cli_login 缺省模型）。 */
  readonly model: string | null | undefined;
  /** 当前 Profile 的 Runtime（模型缺省时按它给保守窗口）。 */
  readonly runtime: string | null | undefined;
  /** 触发阈值（百分比，全局设置 contextWarnPercent）。 */
  readonly warnPercent: number;
}

/** 派生上下文用量表。无任何可用信息（无 usage 且转录为空）时返回 null——没有可提醒的对象。 */
export function deriveContextGauge(input: ContextGaugeInput): ContextGauge | null {
  const usedTokens = input.usage?.usedTokens ?? estimateTokensFromText(input.transcriptText);
  if (usedTokens <= 0) {
    return null;
  }
  const usedEstimated = input.usage === undefined;

  // 分母：Agent 自报（grok ACP usage_update 的 size）最权威；否则查注册表。
  let windowTokens: number;
  let windowEstimated: boolean;
  if (input.usage?.windowTokens !== undefined && input.usage.windowTokens > 0) {
    windowTokens = input.usage.windowTokens;
    windowEstimated = false;
  } else {
    const resolved = resolveContextWindow(input.model, input.runtime);
    windowTokens = resolved.tokens;
    windowEstimated = resolved.source !== "model";
  }

  const percent = Math.floor((usedTokens / windowTokens) * 100);
  return {
    usedTokens,
    windowTokens,
    percent,
    estimated: usedEstimated || windowEstimated,
    shouldWarn: percent >= input.warnPercent,
  };
}
