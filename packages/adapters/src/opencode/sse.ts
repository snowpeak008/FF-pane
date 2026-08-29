/**
 * SSE（text/event-stream）行协议解析（W2.6）。
 *
 * 为什么自己写而不是用 EventSource：Node 24 的全局 EventSource 只接受 URL、
 * 不能复用已有 fetch 响应体，也不能带自定义 Authorization 头（basic auth 是
 * `opencode serve --port` 加 OPENCODE_SERVER_PASSWORD 后的唯一进入方式，
 * 实测 401 → 需 `Basic base64("opencode:<password>")`），且会自动重连——
 * 重连对"一轮会话"语义是有害的（会重放不属于本轮的事件）。本模块只做纯粹的
 * 字节流 → 事件解码，重连与否由调用方决定。
 *
 * 行切分复用 W2.1b 的 createLineDecoder：同一套跨 chunk 半行缓冲与 CRLF 规则，
 * 不再造第二份。数据行的 JSON 解析同样复用 parseJsonlLine，脏数据经
 * InvalidJsonlLine 上交诊断通道（映射器转 raw 事件），与四家 JSONL 适配器一致。
 *
 * 与 WHATWG SSE 规范的两处有意偏差（均有实证理由）：
 * 1. 行终止符只认 LF 与 CRLF，不认孤立 CR。OpenCode 1.18.25 服务端以 `\n\n`
 *    分隔事件（实测），而认孤立 CR 会与 W2.1b 的行解码器规则分叉。
 * 2. flush() 会把"没有以空行收尾的最后一个事件块"照样派发，规范要求丢弃。
 *    理由：abort / 杀进程会在任意位置截断流，丢弃等于丢掉最后一条证据；
 *    JSON 不完整时它会落进脏行通道，不会伪装成正常事件。
 */

import type { JsonlRecord, LineDecoderOptions, StreamChunk } from "../events/index.js";
import { createLineDecoder, parseJsonlLine } from "../events/index.js";

/** 一条已派发的 SSE 事件。 */
export interface SseMessage {
  /** event 字段；缺席时按规范为 "message"。 */
  readonly event: string;
  /** data 字段（多行 data 以 \n 连接，末尾换行已去除）。 */
  readonly data: string;
  /** 最近一次 id 字段（OpenCode 的 `evt_` ULID，可作去重键）。 */
  readonly id?: string;
  /** retry 字段（毫秒）。本模块不重连，原样上交。 */
  readonly retry?: number;
}

/** 有状态 SSE 解码器：push 逐块喂入，flush 收尾。同一实例不可跨流复用。 */
export interface SseDecoder {
  push(chunk: StreamChunk): SseMessage[];
  flush(): SseMessage[];
}

/** 创建 SSE 解码器。 */
export function createSseDecoder(options: LineDecoderOptions = {}): SseDecoder {
  const lineDecoder = createLineDecoder(options);
  let dataLines: string[] = [];
  let eventName = "";
  let lastId: string | undefined;
  let retry: number | undefined;
  let atStreamStart = true;

  function dispatch(out: SseMessage[]): void {
    if (dataLines.length === 0) {
      // 规范：data 缓冲为空的空行只重置 event 名，不派发。
      eventName = "";
      return;
    }
    out.push({
      event: eventName === "" ? "message" : eventName,
      data: dataLines.join("\n"),
      ...(lastId === undefined ? {} : { id: lastId }),
      ...(retry === undefined ? {} : { retry }),
    });
    dataLines = [];
    eventName = "";
  }

  function consume(rawLine: string, out: SseMessage[]): void {
    let line = rawLine;
    if (atStreamStart) {
      atStreamStart = false;
      if (line.startsWith("\uFEFF")) {
        line = line.slice(1);
      }
    }
    if (line === "") {
      dispatch(out);
      return;
    }
    if (line.startsWith(":")) {
      // 注释行 / 心跳（`: ping`），规范要求忽略。
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    switch (field) {
      case "event":
        eventName = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      case "id":
        // 规范：含 NUL 的 id 忽略。
        if (!value.includes("\0")) {
          lastId = value;
        }
        break;
      case "retry": {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed >= 0) {
          retry = parsed;
        }
        break;
      }
      default:
        // 未知字段按规范忽略。
        break;
    }
  }

  return {
    push(chunk: StreamChunk): SseMessage[] {
      const out: SseMessage[] = [];
      for (const line of lineDecoder.push(chunk)) {
        consume(line, out);
      }
      return out;
    },
    flush(): SseMessage[] {
      const out: SseMessage[] = [];
      for (const line of lineDecoder.flush()) {
        consume(line, out);
      }
      // 截断流不丢尾（见文件头偏差说明 2）。
      dispatch(out);
      return out;
    },
  };
}

/** 字节/字符 chunk 流 → SSE 事件流。 */
export async function* decodeSseMessages(
  chunks: AsyncIterable<StreamChunk>,
  options?: LineDecoderOptions,
): AsyncGenerator<SseMessage> {
  const decoder = createSseDecoder(options);
  for await (const chunk of chunks) {
    for (const message of decoder.push(chunk)) {
      yield message;
    }
  }
  for (const message of decoder.flush()) {
    yield message;
  }
}

/**
 * 完整管道：chunk 流 → 原生事件记录流。
 *
 * JsonlRecord.lineNumber 在此语境下是**事件序号**（从 1 起，跳过无 data 的块），
 * 不是物理行号——SSE 一条事件通常占三行（event/data/空行）。
 */
export async function* readSseJsonRecords(
  chunks: AsyncIterable<StreamChunk>,
  options?: LineDecoderOptions,
): AsyncGenerator<JsonlRecord> {
  let ordinal = 0;
  for await (const message of decodeSseMessages(chunks, options)) {
    ordinal += 1;
    const record = parseJsonlLine(message.data, ordinal);
    if (record !== undefined) {
      yield record;
    }
  }
}
