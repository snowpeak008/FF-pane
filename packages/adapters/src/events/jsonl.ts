/**
 * JSONL 行解析（W2.1b）：字节/字符 chunk → 完整行 → 原生 JSON 记录。
 *
 * 三条硬性容错要求，全部来自四份 Runtime 调研的实证：
 * 1. 跨 chunk 的半行缓冲：子进程 stdout 的分块位置由管道决定，一个事件可以被切成
 *    任意份，也可以有多个事件挤在一个 chunk 里。
 * 2. 非 JSON 行不得中断流：claude 跨 cwd resume 时 stdout **首行是纯文本**报错
 *    （claude-code.md §4 / fixture 09-resume-wrong-cwd.jsonl），后面才是正常事件；
 *    codex/opencode 的人类可读警告也可能混入。逐行 try-parse，失败行经
 *    InvalidJsonlLine 上交诊断通道（映射器转 raw 事件），解析继续。
 * 3. 截断流不丢尾：硬杀导致最后一行没有换行符（claude fixture 07），
 *    flush() 仍把残留半行作为一行上交，由解析层判定为脏行而非静默丢弃。
 *
 * 关于编码：接受 Uint8Array 与 string 两种 chunk。字节形式走 TextDecoder 的
 * stream 模式，多字节字符被切在 chunk 边界也不会乱码——codex 的 aggregated_output
 * 实测含中文（fixture exec-basic.jsonl），这不是理论风险。
 */

// 本包未声明 @types/node（由仓库根 hoist 提供），tsconfig 不在本工单改动范围内，
// 故沿用 auth-probe/executor.ts 的做法，以三斜线指令显式纳入 node 类型
// （此处只用到全局 TextDecoder）。
/// <reference types="node" />

import type { RuntimeId } from "@ff-pane/shared";
import type { RawEvent } from "./types.js";

/** 流 chunk：Node 流的 Buffer（Uint8Array）或已 setEncoding 后的字符串。 */
export type StreamChunk = string | Uint8Array;

/**
 * 单行最大字符数（默认 8 MiB）。超限即强制切行，把已缓冲内容作为一行上交，
 * 避免"没有换行符的巨流"把内存吃光；被切开的部分会以脏行形式进入诊断通道，
 * 不静默丢弃。实测四家 fixture 的最长行不足 4 KB，8 MiB 只是防御性上限。
 */
export const DEFAULT_MAX_LINE_LENGTH = 8 * 1024 * 1024;

/** 行解码器选项。 */
export interface LineDecoderOptions {
  /** 单行最大字符数，默认 DEFAULT_MAX_LINE_LENGTH。 */
  readonly maxLineLength?: number;
}

/** 有状态行解码器：push 逐块喂入，flush 收尾。同一实例不可跨流复用。 */
export interface LineDecoder {
  /** 喂入一个 chunk，返回本次凑齐的完整行（已剥离行尾 \n 与 \r）。 */
  push(chunk: StreamChunk): string[];
  /** 流结束：冲出解码器残留字节，并把最后一段无换行符的内容作为一行返回。 */
  flush(): string[];
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * 创建行解码器。兼容 LF 与 CRLF；保留行内空行（JSONL 里的空行由解析层跳过）；
 * 末尾换行符不产生空行。
 */
export function createLineDecoder(options: LineDecoderOptions = {}): LineDecoder {
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  if (!Number.isInteger(maxLineLength) || maxLineLength < 1) {
    throw new RangeError(`createLineDecoder: maxLineLength 必须是正整数，收到 ${maxLineLength}`);
  }

  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  // buffer 中已确认不含 "\n" 的前缀长度：让"1 字节 chunk 喂长行"保持线性开销，
  // 而不是每次 push 都重扫整个缓冲。
  let scanned = 0;

  function drain(): string[] {
    const lines: string[] = [];
    let start = 0;
    let index = buffer.indexOf("\n", scanned);
    while (index !== -1) {
      lines.push(stripCarriageReturn(buffer.slice(start, index)));
      start = index + 1;
      index = buffer.indexOf("\n", start);
    }
    if (start > 0) {
      buffer = buffer.slice(start);
    }
    while (buffer.length > maxLineLength) {
      lines.push(buffer.slice(0, maxLineLength));
      buffer = buffer.slice(maxLineLength);
    }
    scanned = buffer.length;
    return lines;
  }

  return {
    push(chunk: StreamChunk): string[] {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      return drain();
    },
    flush(): string[] {
      // 无参 decode() 冲出 stream 模式的残留字节（不完整多字节序列 → U+FFFD）。
      buffer += decoder.decode();
      const lines = drain();
      if (buffer !== "") {
        lines.push(stripCarriageReturn(buffer));
        buffer = "";
        scanned = 0;
      }
      return lines;
    },
  };
}

/**
 * 将整段文本按行切分（兼容 \n 与 \r\n），丢弃末尾空行。
 * T0.1 起从包根导出，语义保持不变，实现改为复用行解码器（同一套切行规则，
 * 一次性文本与流式分块不会出现行为分叉）。
 */
export function splitLines(text: string): string[] {
  const decoder = createLineDecoder();
  return [...decoder.push(text), ...decoder.flush()];
}

/** 解析成功的 JSONL 行。 */
export interface ParsedJsonlLine {
  readonly ok: true;
  /** 行号，从 1 起，含空行计数——与 Run 原始日志的行号对得上。 */
  readonly lineNumber: number;
  /** 原始行文本（不含行尾符）。 */
  readonly raw: string;
  /** JSON.parse 的结果。四家事件均为顶层对象，故此处已收窄为对象。 */
  readonly value: Record<string, unknown>;
}

/** 脏行：JSON 解析失败或顶层不是对象。原文与原因一并上交，不丢证据。 */
export interface InvalidJsonlLine {
  readonly ok: false;
  readonly lineNumber: number;
  readonly raw: string;
  /** 失败原因（JSON.parse 的错误信息，或"顶层不是 JSON 对象"）。 */
  readonly reason: string;
}

/** 一行的解析结果。 */
export type JsonlRecord = ParsedJsonlLine | InvalidJsonlLine;

/** 判断是否为 JSON 对象（排除 null 与数组）。 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读取原生事件的顶层 type 字段——codex/claude/gemini 的 JSONL 与 opencode 的
 * SSE 载荷全部以顶层 `type` 判别（四份调研 §"事件流格式"），映射器的第一步共用此函数。
 * 非对象或该字段不是字符串时返回 undefined。
 */
export function nativeEventType(value: unknown): string | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const type = value["type"];
  return typeof type === "string" ? type : undefined;
}

/**
 * 解析一行。空行（去空白后为空）返回 undefined —— JSONL 与 SSE 都会出现空行，
 * 那不是异常，不该占用诊断通道。
 */
export function parseJsonlLine(line: string, lineNumber: number): JsonlRecord | undefined {
  if (line.trim() === "") {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    return {
      ok: false,
      lineNumber,
      raw: line,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!isJsonObject(value)) {
    return { ok: false, lineNumber, raw: line, reason: "顶层不是 JSON 对象" };
  }
  return { ok: true, lineNumber, raw: line, value };
}

/**
 * 构造 raw 兜底事件（见 types.ts 中 AGENT_EVENT_KINDS 的取舍论证）。
 * 两类用法：① 归不进六类的原生事件 —— native 传已解析的对象；
 * ② 脏行 —— native 传 record.raw，note 传 record.reason。
 */
export function toRawEvent(runtime: RuntimeId, native: unknown, note?: string): RawEvent {
  const nativeType = nativeEventType(native);
  return {
    kind: "raw",
    runtime,
    native,
    ...(nativeType === undefined ? {} : { nativeType }),
    ...(note === undefined ? {} : { note }),
  };
}
