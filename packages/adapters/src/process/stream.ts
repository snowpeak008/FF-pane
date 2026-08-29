/**
 * 子进程输出流 → AsyncIterable<Buffer>（W2.1a）。
 *
 * 为什么不直接把 child.stdout 交出去：Readable 的异步迭代走 read()，消费方慢时
 * 会把缓冲区里多个块**合并**成一块交出，块边界不再等于内核实际写入的边界。
 * 本层承诺"字节不丢、不合并、不错序"，所以自己接 'data' 事件排队，逐块原样产出。
 *
 * 背压：排队字节超过 highWaterMark 即 pause 源流（内核管道随之顶住写端），
 * 消费方追上后 resume。代价是**两条流都必须被消费**，否则输出量大的进程会被
 * 背压挡在写 stdout 上而迟迟不退出（此时 spec.timeoutMs 是兜底）。
 *
 * 行切分、JSONL 解析、事件级背压是 W2.1b（events/）的事，本层不看内容。
 */

/// <reference types="node" />

import type { Readable } from "node:stream";

/** 单条流默认排队上限：4 MiB。 */
export const DEFAULT_STREAM_HIGH_WATER_MARK = 4 * 1024 * 1024;

/**
 * 单消费者的字节块队列。只允许一个 for-await 循环消费（多消费者会各自拿到
 * 队列的一部分，等于把流切碎，属误用）。
 */
export class ByteChunkQueue implements AsyncIterable<Buffer> {
  private readonly chunks: Buffer[] = [];
  private readonly source: Readable | null;
  private readonly highWaterMark: number;
  private queuedBytes = 0;
  private ended = false;
  private failure: Error | null = null;
  private paused = false;
  private wakeup: (() => void) | null = null;

  /** source 为 null（stdio 未开管道 / spawn 失败）时，直接是一条空的已结束流。 */
  constructor(source: Readable | null, highWaterMark = DEFAULT_STREAM_HIGH_WATER_MARK) {
    this.source = source;
    this.highWaterMark = highWaterMark > 0 ? highWaterMark : DEFAULT_STREAM_HIGH_WATER_MARK;
    if (source === null) {
      this.ended = true;
      return;
    }
    source.on("data", (chunk: Buffer | string) => {
      this.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    source.once("end", () => {
      this.finish(null);
    });
    source.once("close", () => {
      this.finish(null);
    });
    source.once("error", (error: Error) => {
      this.finish(error);
    });
  }

  /** 当前排队字节数（诊断用）。 */
  get pendingBytes(): number {
    return this.queuedBytes;
  }

  private push(chunk: Buffer): void {
    if (this.ended || chunk.length === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.queuedBytes += chunk.length;
    if (!this.paused && this.queuedBytes >= this.highWaterMark) {
      this.paused = true;
      this.source?.pause();
    }
    this.wake();
  }

  private finish(error: Error | null): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    if (error !== null) {
      this.failure = error;
    }
    this.wake();
  }

  private wake(): void {
    const resolve = this.wakeup;
    if (resolve !== null) {
      this.wakeup = null;
      resolve();
    }
  }

  private waitForChange(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wakeup = resolve;
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
    for (;;) {
      const chunk = this.chunks.shift();
      if (chunk !== undefined) {
        this.queuedBytes -= chunk.length;
        if (this.paused && this.queuedBytes < this.highWaterMark) {
          this.paused = false;
          this.source?.resume();
        }
        yield chunk;
        continue;
      }
      if (this.failure !== null) {
        // 已排队的字节先交完，再把读取错误抛给消费方（流被截断必须让上层知道）。
        const error = this.failure;
        this.failure = null;
        throw error;
      }
      if (this.ended) {
        return;
      }
      await this.waitForChange();
    }
  }
}
