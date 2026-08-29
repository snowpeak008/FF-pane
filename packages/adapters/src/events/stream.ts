/**
 * 背压安全的事件流管道（W2.1b）：chunk 流 → 行流 → 原生记录流。
 *
 * 背压策略：全部用异步生成器，**拉模型**。生成器体在消费方调用 next() 之前不会
 * 前进一步，`for await (const chunk of chunks)` 也就不会去取下一个 chunk；
 * 于是数据留在上游 Node 流的内部缓冲里，触及 highWaterMark 后由操作系统管道
 * 反压到 Agent 子进程——消费慢时天然停止读取，管道内不存在任何无界队列。
 * 唯一的中间缓冲是"一个 chunk 切出的行数组"，其上界即 highWaterMark，有界。
 *
 * 对 W2.1a（子进程管理）的假设：上游 AsyncIterable 是**拉式**的
 *（Node Readable 的 Symbol.asyncIterator 正是如此）。若 W2.1a 交出的是推式流
 *（事件回调/无界队列），背压保证在它那一侧就已失效，需要在 W2.1c 接线时用
 * 有界队列适配——本模块不承担该转换，接口对齐归 W2.1c。
 *
 * 提前退出：消费方 break/throw 时，for-await 会对上游迭代器调用 return()，
 * Node Readable 据此销毁流并关闭管道读端，不留悬挂读取。
 */

import type { JsonlRecord, LineDecoderOptions, StreamChunk } from "./jsonl.js";
import { createLineDecoder, parseJsonlLine } from "./jsonl.js";

/**
 * chunk 流 → 行流。跨 chunk 半行由行解码器缓冲；流结束时残留半行也会上交
 *（截断流不丢尾）。
 */
export async function* decodeLines(
  chunks: AsyncIterable<StreamChunk>,
  options?: LineDecoderOptions,
): AsyncGenerator<string> {
  const decoder = createLineDecoder(options);
  for await (const chunk of chunks) {
    for (const line of decoder.push(chunk)) {
      yield line;
    }
  }
  for (const line of decoder.flush()) {
    yield line;
  }
}

/**
 * 行流 → 原生记录流。空行跳过（但仍计入行号），脏行以 InvalidJsonlLine 上交，
 * 解析不中断。
 */
export async function* parseJsonlLines(lines: AsyncIterable<string>): AsyncGenerator<JsonlRecord> {
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    const record = parseJsonlLine(line, lineNumber);
    if (record !== undefined) {
      yield record;
    }
  }
}

/**
 * 完整管道：chunk 流 → 原生记录流。适配器（W2.3~2.6）以此为输入，
 * 逐条映射为 AgentEvent。
 */
export function readJsonlStream(
  chunks: AsyncIterable<StreamChunk>,
  options?: LineDecoderOptions,
): AsyncGenerator<JsonlRecord> {
  return parseJsonlLines(decodeLines(chunks, options));
}
