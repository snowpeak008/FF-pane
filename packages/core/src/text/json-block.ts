/**
 * 「从模型自由文本里取出一个 JSON 块并清洗字段」的公共零件。
 *
 * 两个消费者（计划生成 T4.6、审查结论 T7.2）面对的是同一件事：模型的答复是散文，
 * 里面藏着一个约定好的结构化块，而块里每个字段都可能缺、可能类型不对、可能是空白。
 * 这些容错规则一旦两处各写一份就会各自漂移——一边容忍裸围栏块、另一边不容忍，
 * 表现为"同一个模型在计划轮解析得出来、在审查轮解析不出来"这类极难归因的差异。
 *
 * 内部零件：不进 core 的 barrel。它没有领域含义，只是解析细节。
 */

/**
 * 提取答复中最后一个围栏代码块的内容（优先带 json 标签的块，其次任意围栏块）。
 *
 * 取**最后一个**而非第一个：模型常先在正文里举个例子说明格式，再给真正的结果；
 * 容忍**无语言标签**的裸围栏块：漏写 ```json 是最高频的格式偏差，为它判定失败
 * 只会把一次本可用的输出丢掉。
 */
export function extractLastJsonBlock(text: string): string | undefined {
  const fence = /```(json)?[ \t]*\r?\n([\s\S]*?)```/gi;
  let lastJson: string | undefined;
  let lastAny: string | undefined;
  for (let m = fence.exec(text); m !== null; m = fence.exec(text)) {
    const body = m[2] ?? "";
    lastAny = body;
    if (m[1] !== undefined) {
      lastJson = body;
    }
  }
  return lastJson ?? lastAny;
}

/** 把任意值清洗为"非空字符串数组"（非数组→空；逐条 trim、丢空）。 */
export function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed.length > 0) {
        out.push(trimmed);
      }
    }
  }
  return out;
}

/** 非空字符串取 trim 后的值，否则 undefined。 */
export function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
