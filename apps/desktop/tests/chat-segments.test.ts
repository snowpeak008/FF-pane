import { describe, expect, it } from "vitest";
import { parseChatSegments } from "../src/renderer/src/pages/session/chat-segments";

describe("parseChatSegments", () => {
  it("纯散文 → 单个 prose 段", () => {
    expect(parseChatSegments("hello world")).toEqual([{ kind: "prose", text: "hello world" }]);
  });

  it("散文 + 代码块 + 散文", () => {
    expect(parseChatSegments("before\n```js\nconst a = 1;\n```\nafter")).toEqual([
      { kind: "prose", text: "before" },
      { kind: "code", lang: "js", text: "const a = 1;", closed: true },
      { kind: "prose", text: "after" },
    ]);
  });

  it("代码块保留内部空行与缩进", () => {
    const seg = parseChatSegments("```py\ndef f():\n\n    return 1\n```");
    expect(seg).toEqual([
      { kind: "code", lang: "py", text: "def f():\n\n    return 1", closed: true },
    ]);
  });

  it("未闭合围栏（流式中）→ closed:false 的代码段", () => {
    expect(parseChatSegments("```ts\nconst x = ")).toEqual([
      { kind: "code", lang: "ts", text: "const x = ", closed: false },
    ]);
  });

  it("无语言的围栏 → lang 空串", () => {
    expect(parseChatSegments("```\nplain\n```")).toEqual([
      { kind: "code", lang: "", text: "plain", closed: true },
    ]);
  });

  it("丢弃代码块前后的纯空白散文段", () => {
    const seg = parseChatSegments("\n\n```\ncode\n```\n\n");
    expect(seg).toEqual([{ kind: "code", lang: "", text: "code", closed: true }]);
  });
});
