/**
 * 命令面板的搜索匹配（W3.1c）——纯函数，中英文均可命中。
 *
 * 为什么不用 cmdk 内置的 command-score：它按拉丁文单词边界打分，
 * 中文（无空格、无词边界）几乎拿不到分；面板因此关掉 shouldFilter，
 * 由本模块过滤后只渲染命中项。
 *
 * 跨语言命中靠语言包：每个命令在 **两个** 语言包里都带
 * `keywords`（中英词混排，如 "session chat 会话 对话"），
 * 所以中文界面下输入 "session" 能命中，英文界面下输入 "会话" 也能命中。
 * 键位串也参与匹配：输入 "Ctrl+K" 能直接搜到命令面板本身。
 *
 * 打分档位（取各字段最高分；keywords/键位打折，标题优先）：
 *   完全相等 6 > 前缀 5 > 词首子串 4 > 任意子串 3 > 子序列（模糊）2
 * 多个空格分隔的词按 AND：任一词无命中则整项不命中，总分取各词均分。
 */

export interface SearchableFields {
  readonly id: string;
  /** 已翻译的命令标题。 */
  readonly title: string;
  /** 已翻译的搜索关键词（空格分隔，含中英双语词）。 */
  readonly keywords?: string | undefined;
  /** 键位展示串（"Ctrl+K"），一并参与匹配。 */
  readonly shortcut?: string | undefined;
}

const SCORE_EXACT = 6;
const SCORE_PREFIX = 5;
const SCORE_WORD_START = 4;
const SCORE_SUBSTRING = 3;
const SCORE_SUBSEQUENCE = 2;

/** keywords 与键位串的权重折扣，保证标题命中排在前面。 */
const KEYWORDS_WEIGHT = 0.7;
const SHORTCUT_WEIGHT = 0.5;

function normalize(text: string): string {
  return text.toLowerCase().trim();
}

/** 词边界：串首，或前一个字符不是字母/数字（中文每个字都算边界，故只看拉丁词）。 */
function isWordStart(text: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  const previous = text[index - 1];
  return previous === undefined || !/[a-z0-9]/.test(previous);
}

function isSubsequence(text: string, token: string): boolean {
  let cursor = 0;
  for (const char of text) {
    if (char === token[cursor]) {
      cursor += 1;
      if (cursor === token.length) {
        return true;
      }
    }
  }
  return token.length === 0;
}

/** 单字段对单个查询词的得分；0 表示不命中。 */
export function scoreField(field: string, token: string): number {
  if (token.length === 0) {
    return 0;
  }
  const text = normalize(field);
  if (text.length === 0) {
    return 0;
  }
  if (text === token) {
    return SCORE_EXACT;
  }
  const index = text.indexOf(token);
  if (index === 0) {
    return SCORE_PREFIX;
  }
  if (index > 0) {
    return isWordStart(text, index) ? SCORE_WORD_START : SCORE_SUBSTRING;
  }
  return isSubsequence(text, token) ? SCORE_SUBSEQUENCE : 0;
}

/** 整项对整条查询的得分；0 表示不命中。空查询一律 1（全部展示，保持原序）。 */
export function scoreSearchMatch(item: SearchableFields, query: string): number {
  const tokens = normalize(query)
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return 1;
  }
  let total = 0;
  for (const token of tokens) {
    const best = Math.max(
      scoreField(item.title, token),
      scoreField(item.keywords ?? "", token) * KEYWORDS_WEIGHT,
      scoreField(item.shortcut ?? "", token) * SHORTCUT_WEIGHT,
    );
    if (best === 0) {
      return 0;
    }
    total += best;
  }
  return total / tokens.length;
}

/** 过滤 + 按得分降序（同分保持原序，保证列表顺序稳定可预期）。 */
export function filterBySearch<T extends SearchableFields>(
  items: readonly T[],
  query: string,
): readonly T[] {
  const scored = items
    .map((item, index) => ({ item, index, score: scoreSearchMatch(item, query) }))
    .filter((entry) => entry.score > 0);
  scored.sort((left, right) =>
    right.score === left.score ? left.index - right.index : right.score - left.score,
  );
  return scored.map((entry) => entry.item);
}
