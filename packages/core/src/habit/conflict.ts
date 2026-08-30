/**
 * 习惯入库前的相近条目检测（T5.1，设计文档 §8.2.5）。
 *
 * 定位（诚实边界）：本模块只做**字面相近**检测——用字符二元组（bigram）的
 * Jaccard 相似度找出与新习惯高度重合的既有条目，供界面并排展示，让用户选择
 * 合并 / 替代 / 都保留。它**不做语义矛盾判定**（"先写测试" vs "先写实现" 字面
 * 相近但语义相反，靠人判断）——把相近条目摆到用户面前，判断权归用户。
 *
 * 纯函数、零 IO。习惯集合上限 80 条（§8.2.5），全量内存比对足够，不上索引。
 * 中英文通用：以 Unicode 码点为单位切二元组，中文按字、英文按字符，无需分词。
 */

import type { HabitEntry, HabitEntryId } from "@ff-pane/shared";

/** 判定为「相近」的相似度阈值（Jaccard，0~1）。经验取值，可由调用方覆盖。 */
export const HABIT_CONFLICT_SIMILARITY_THRESHOLD = 0.4;

/** 默认最多返回的相近条目数（避免噪声淹没）。 */
export const HABIT_CONFLICT_DEFAULT_LIMIT = 5;

/** 一条相近条目：既有习惯 + 与新习惯的相似度。 */
export interface HabitConflict {
  readonly entry: HabitEntry;
  /** Jaccard 相似度（0~1，越大越像）。 */
  readonly similarity: number;
}

/** detectHabitConflicts 的输入：待入库习惯的分类与文本（可选排除自身 id，用于编辑场景）。 */
export interface HabitConflictInput {
  readonly category: HabitEntry["category"];
  readonly content: string;
  /** 编辑既有条目时排除自身，避免自己和自己"相近"。 */
  readonly excludeId?: HabitEntryId;
}

/** detectHabitConflicts 的可选参数。 */
export interface HabitConflictOptions {
  readonly threshold?: number;
  readonly limit?: number;
}

/** 归一化：去首尾空白、转小写、剥离常见标点与内部空白，保留中英文有效字符。 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

/** 生成字符二元组集合；长度 < 2 时退化为单字符集合。 */
function bigrams(normalized: string): ReadonlySet<string> {
  const chars = [...normalized];
  if (chars.length < 2) {
    return new Set(chars);
  }
  const grams = new Set<string>();
  for (let i = 0; i < chars.length - 1; i += 1) {
    grams.add(`${chars[i]}${chars[i + 1]}`);
  }
  return grams;
}

/** 两集合的 Jaccard 相似度（交集 / 并集）。空集对空集视为 0（无可比信息）。 */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const gram of a) {
    if (b.has(gram)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 计算两段文本的相近度（0~1），供测试与上层复用。 */
export function habitTextSimilarity(a: string, b: string): number {
  return jaccard(bigrams(normalize(a)), bigrams(normalize(b)));
}

/**
 * 在既有习惯中找出与输入相近的条目，按相似度降序返回（≥ 阈值、去除 excludeId、
 * 截断到 limit）。同分类的条目相似度加成——同类相近更可能是真重复/冲突。
 * archived 条目由调用方决定是否传入（一般只比 active + candidate）。
 */
export function detectHabitConflicts(
  input: HabitConflictInput,
  existing: readonly HabitEntry[],
  options: HabitConflictOptions = {},
): readonly HabitConflict[] {
  const threshold = options.threshold ?? HABIT_CONFLICT_SIMILARITY_THRESHOLD;
  const limit = options.limit ?? HABIT_CONFLICT_DEFAULT_LIMIT;
  const inputGrams = bigrams(normalize(input.content));

  const scored: HabitConflict[] = [];
  for (const entry of existing) {
    if (input.excludeId !== undefined && entry.id === input.excludeId) {
      continue;
    }
    const base = jaccard(inputGrams, bigrams(normalize(entry.content)));
    // 同分类小幅加成（上限 1），把同类相近顶到阈值之上更容易被看见。
    const similarity = entry.category === input.category ? Math.min(1, base + base * 0.15) : base;
    if (similarity >= threshold) {
      scored.push({ entry, similarity });
    }
  }

  scored.sort((a, b) => {
    if (b.similarity !== a.similarity) {
      return b.similarity - a.similarity;
    }
    // 相似度同分时按更新时间新者优先，稳定可测。
    if (b.entry.updatedAt !== a.entry.updatedAt) {
      return b.entry.updatedAt - a.entry.updatedAt;
    }
    return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
  });
  return scored.slice(0, limit);
}
