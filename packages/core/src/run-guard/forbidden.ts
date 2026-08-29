/**
 * 任务合同 forbidden 的禁写模式派生（W2.7a）。
 *
 * ## 为什么需要派生
 * §6.2 的 forbidden 是"禁止事项"自由文本（Planner 写给 Worker 看的话，如
 * "不要修改 src/legacy/"、"不要动 pnpm-lock.yaml"），不是结构化路径列表。
 * 写路径裁决需要可机判的模式，故从文本中抽取"明显是路径"的 token。
 *
 * ## 抽取规则（本工单定义）
 * 1. 按空白切词，剥除词首尾的引号与中英文标点（不剥 "/"，尾斜杠对作用域无害）；
 * 2. 只保留"明显路径形态"的 token：含 "/" 或 "\"、含通配符 "*" / "?"、
 *    或形如带扩展名的文件名（`pnpm-lock.yaml`、`README.md`）；
 * 3. token 需能被 W1.4c 的 parsePathScope 解析（项目外形态与含 ".." 者跳过——
 *    项目外写入另有恒拒规则把守，不需要 forbidden 重复表达）；
 * 4. 渲染为 "**"（全项目子树）的 token 一律跳过：整项目禁写应由信封的 writePaths
 *    表达，若允许 forbidden 表达它，一个手误的 "**" 会让整个 Run 寸步难行，
 *    且 forbidden 无审批通道可解。
 *
 * 方向说明：这里刻意"宁松勿滥"（与拦截层的宁严勿松相反）——forbidden 命中是
 * **恒拒且无审批通道**的硬拒绝，把散文里的普通词（"测试"、"文档"）误当目录会
 * 直接卡死正常工作。裸目录名（不含斜杠、不含扩展名）因此不参与派生，Planner
 * 想禁某个目录请写成 `src/legacy/` 或 `src/legacy/**`。
 */

import { parsePathScope, renderPathScope } from "../permission/index.js";

/** 词首需剥除的装饰字符（引号、各类括号）。 */
const LEADING_DECORATION = /^[\s"'`([{（【「《]+/u;

/** 词尾需剥除的装饰字符（引号、括号、中英文标点；不含 "/"）。 */
const TRAILING_DECORATION = /[\s"'`)\]}）】」》,，。、;；:：!！?？]+$/u;

/** 明显路径形态：含路径分隔符或通配符。 */
const PATH_LIKE_TOKEN = /[/\\*?]/;

/** 带扩展名的文件名（如 pnpm-lock.yaml、README.md、tsconfig.base.json）。 */
const FILENAME_WITH_EXTENSION = /^[\w@.+-]+\.[a-z0-9]{1,8}$/i;

function stripDecoration(token: string): string {
  return token.replace(LEADING_DECORATION, "").replace(TRAILING_DECORATION, "");
}

function isPathLikeToken(token: string): boolean {
  return PATH_LIKE_TOKEN.test(token) || FILENAME_WITH_EXTENSION.test(token);
}

/**
 * 从任务合同的 forbidden 文本列表派生禁写模式（规范形态、已去重）。
 * 结果直接作为 judgeFileChange / auditRunEvidence 的 forbiddenPaths 入参。
 */
export function deriveForbiddenPathPatterns(forbidden: readonly string[]): readonly string[] {
  const patterns: string[] = [];
  for (const entry of forbidden) {
    for (const word of entry.split(/\s+/u)) {
      const token = stripDecoration(word);
      if (token === "" || !isPathLikeToken(token)) {
        continue;
      }
      const scope = parsePathScope(token);
      if (scope === null) {
        continue;
      }
      const canonical = renderPathScope(scope);
      if (canonical === "**" || patterns.includes(canonical)) {
        continue;
      }
      patterns.push(canonical);
    }
  }
  return Object.freeze(patterns);
}
