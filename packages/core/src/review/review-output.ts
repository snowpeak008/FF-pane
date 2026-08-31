/**
 * Reviewer 的结构化结论合同与解析（T7.2，设计文档 §3.1）。
 *
 * 纯函数、零 IO。合同（REVIEW_OUTPUT_CONTRACT）与解析（parseReviewConclusion）同文件，
 * schema 只定义一次——与 T4.6 的计划输出合同同一处置。
 *
 * ## 解析失败一律落 inconclusive，绝不猜
 * 没有结论块、JSON 非法、verdict 不是三个字面量之一——统统落 `inconclusive` 并把原文
 * 整段留在 summary 里。理由是代价不对称：把 fail 猜成 pass，用户看到的是一份"通过了
 * 审查"的不合格改动；而落 inconclusive 最坏也只是让用户自己读一遍原文。这也是本模块
 * 不返回 `{ ok: false }` 的原因——计划轮解析失败可以什么都不写盘（用户重来一次即可），
 * 审查轮已经真金白银跑过一遍只读命令，把结果丢掉才是浪费。
 */

import type { ReviewVerdict } from "@ff-pane/shared";
import { isReviewVerdict } from "@ff-pane/shared";
import { extractLastJsonBlock, nonEmptyString, toStringList } from "../text/json-block.js";

/**
 * 追加到 Reviewer 提示词末尾的结构化结论合同（放最末 = 最新指令）。
 * 与 parseReviewConclusion 的 schema 严格对应。
 */
export const REVIEW_OUTPUT_CONTRACT = `# 审查结论（结构化输出）
对照上面的验收标准逐条核对实际改动，然后给出结论。严格遵守：
1. 你**只读**：不要修改任何文件。除任务合同的验证命令外，不要尝试执行其他命令
   （没有权限，尝试会被拦截并中断本轮）。
2. 答复的最后只输出一个 \`\`\`json 代码块，块内是合法 JSON：
\`\`\`json
{
  "verdict": "pass",
  "summary": "结论理由，一到三句；说明你核对了哪些验收标准、依据是什么",
  "findings": ["不合格之处，逐条列出（通过时给空数组）"]
}
\`\`\`
3. verdict 三选一：\`pass\`（全部验收标准都已满足）、\`fail\`（有验收标准未满足）、
   \`inconclusive\`（证据不足以判断，此时在 findings 里写明还缺什么）。
4. 只依据以上给出的验收标准与执行证据判断。不要凭印象补全未给出的历史，
   也不要因为"看起来做得不错"而放过没写在验收标准里的要求——反之亦然。`;

/** 解析出的审查结论（不含时间/Profile 等由编排层补齐的字段）。 */
export interface ReviewConclusion {
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  readonly findings: readonly string[];
}

/** 答复整段空白时的 summary 占位（面向用户，进 Run 记录）。 */
const EMPTY_ANSWER_SUMMARY = "Reviewer 没有给出任何答复。";

/**
 * 从 Reviewer 答复文本解析结论。永不抛错、永不失败：解析不出结构化结论时
 * 落 `inconclusive` 并保留原文（理由见模块注释）。
 */
export function parseReviewConclusion(text: string): ReviewConclusion {
  const raw = text.trim();
  const fallback = (summary: string): ReviewConclusion => ({
    verdict: "inconclusive",
    summary: summary.length > 0 ? summary : EMPTY_ANSWER_SUMMARY,
    findings: [],
  });

  const block = extractLastJsonBlock(raw);
  if (block === undefined) {
    return fallback(raw);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return fallback(raw);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fallback(raw);
  }
  const obj = parsed as Record<string, unknown>;
  const verdict = nonEmptyString(obj["verdict"])?.toLowerCase();
  if (verdict === undefined || !isReviewVerdict(verdict)) {
    return fallback(raw);
  }
  const findings = toStringList(obj["findings"]);
  const summary = nonEmptyString(obj["summary"]);
  return {
    verdict,
    // summary 缺失但 verdict 合法：结论本身作数，只是没给理由。此时退回原文而不是
    // 造一句"（无理由）"——原文里通常正写着理由，只是模型忘了填进字段。
    summary: summary ?? (raw.length > 0 ? raw : EMPTY_ANSWER_SUMMARY),
    findings,
  };
}
