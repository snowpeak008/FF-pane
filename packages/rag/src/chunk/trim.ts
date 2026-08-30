/**
 * 块边缘空白修剪（T6.2）。
 *
 * 为什么不能直接用 String.trim()：块正文里有源代码。切分点常常落在一个缩进的
 * 代码行上（`  scores.set(...)`），trim() 会把那行的缩进吃掉，用户在检索结果里
 * 看到的就是一段错位的代码。缩进是内容，不是排版空白。
 *
 * 故规则是：去掉首尾的**空行**与行尾空白，保留首个非空行自身的缩进。
 */

/** 该字符是否是空白（含换行）。 */
function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

/** 去掉首尾空行与尾部空白，保留首个非空行的缩进。 */
export function trimBlankEdges(text: string): string {
  let start = 0;
  while (start < text.length && isWhitespace(text[start] ?? "")) {
    start += 1;
  }
  if (start >= text.length) {
    return "";
  }
  // 退回到首个非空字符所在行的行首，把该行的缩进还回来
  const lineStart = text.lastIndexOf("\n", start);
  if (lineStart >= 0) {
    start = lineStart + 1;
  } else {
    start = 0;
  }

  let end = text.length;
  while (end > start && isWhitespace(text[end - 1] ?? "")) {
    end -= 1;
  }
  return text.slice(start, end);
}
