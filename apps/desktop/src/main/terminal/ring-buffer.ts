/**
 * 终端输出环形缓冲（按字节上限截断），供渲染端重新挂载回放与后续「读窗口输出」。
 */

export class ByteRingBuffer {
  private chunks: Buffer[] = [];
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {
    if (maxBytes <= 0) {
      throw new Error("ByteRingBuffer maxBytes must be positive");
    }
  }

  /** 追加一段输出；超限时从头部丢弃整块，直到总字节数回到上限内。 */
  append(data: string | Buffer): void {
    const chunk = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    if (chunk.byteLength === 0) {
      return;
    }
    if (chunk.byteLength >= this.maxBytes) {
      this.chunks = [Buffer.from(chunk.subarray(chunk.byteLength - this.maxBytes))];
      this.totalBytes = this.maxBytes;
      return;
    }
    this.chunks.push(chunk);
    this.totalBytes += chunk.byteLength;
    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const dropped = this.chunks.shift();
      if (dropped === undefined) {
        break;
      }
      this.totalBytes -= dropped.byteLength;
    }
  }

  /** 按写入顺序拼接为 UTF-8 字符串（截断边界可能落在多字节字符中间，调用方按字节语义使用）。 */
  toString(): string {
    if (this.chunks.length === 0) {
      return "";
    }
    return Buffer.concat(this.chunks, this.totalBytes).toString("utf8");
  }

  byteLength(): number {
    return this.totalBytes;
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}
