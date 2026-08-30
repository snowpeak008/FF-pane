/**
 * 消息分段解析（W3.4a）：把 Agent 输出文本切成「代码块」与「散文」两类段，
 * 供消息流按类型分别渲染（代码块等宽+凹陷底，散文保留换行）。纯函数，可单测。
 *
 * 流式容错：输出是增量到达的，代码围栏（三反引号）可能尚未闭合——未闭合的围栏之后
 * 一律按代码块渲染（标 unterminated），避免半个围栏把代码当散文闪一下。
 */

/** 一段消息内容：代码块或散文。 */
export type ChatSegment =
  | {
      readonly kind: "code";
      readonly lang: string;
      readonly text: string;
      readonly closed: boolean;
    }
  | { readonly kind: "prose"; readonly text: string };

/** 围栏行：整行仅由可选缩进 + 三反引号（\x60）+ 可选语言构成。 */
const FENCE = /^\s*\x60\x60\x60(.*)$/;

/**
 * 解析消息文本为段序列。散文段会丢弃纯空白内容（避免代码块前后的空行产生空段）；
 * 代码块内容原样保留（含空行与缩进）。
 */
export function parseChatSegments(content: string): readonly ChatSegment[] {
  const lines = content.split("\n");
  const segments: ChatSegment[] = [];
  let proseLines: string[] = [];
  let codeLines: string[] | null = null;
  let codeLang = "";

  const flushProse = (): void => {
    const text = proseLines.join("\n");
    if (text.trim().length > 0) {
      segments.push({ kind: "prose", text });
    }
    proseLines = [];
  };

  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (fence !== null) {
      if (codeLines === null) {
        flushProse();
        codeLines = [];
        codeLang = (fence[1] ?? "").trim();
      } else {
        segments.push({ kind: "code", lang: codeLang, text: codeLines.join("\n"), closed: true });
        codeLines = null;
        codeLang = "";
      }
      continue;
    }
    if (codeLines !== null) {
      codeLines.push(line);
    } else {
      proseLines.push(line);
    }
  }

  if (codeLines !== null) {
    // 未闭合围栏（流式进行中）：其后内容按代码块渲染
    segments.push({ kind: "code", lang: codeLang, text: codeLines.join("\n"), closed: false });
  } else {
    flushProse();
  }

  return segments;
}
