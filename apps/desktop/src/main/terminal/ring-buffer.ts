/**
 * 终端输出环形缓冲（按字节上限截断），供渲染端重新挂载回放与后续「读窗口输出」。
 *
 * 字节拷进连续的 64KB 块里存（T11.0d）。原来每段输出各留一个小 Buffer：小 Buffer 来自
 * Node 共享的 8KB 池，几十字节的转圈输出留几个小时，能占住一整块池，十几个终端加起来
 * 远超 1MB 的上限。块用 allocUnsafeSlow 单独分配，不进池。
 * 截断仍按写入时的一段一段整段丢（onEvict 收到的和以前一样）。
 */

const BLOCK_BYTES = 64 * 1024;

export class ByteRingBuffer {
  private blocks: Buffer[] = [];
  /** 第一块里已经丢掉的字节数。 */
  private head = 0;
  /** 最后一块里已经写了的字节数。 */
  private tailUsed = 0;
  /** 每段输出的长度，按写入顺序；lengthsHead 之前的已经丢掉。 */
  private lengths: number[] = [];
  private lengthsHead = 0;
  private totalBytes = 0;

  /** onEvict 按写入顺序收到被挤掉的输出（整块或大块的前半截）。 */
  constructor(
    private readonly maxBytes: number,
    private readonly onEvict?: (dropped: Buffer) => void,
  ) {
    if (maxBytes <= 0) {
      throw new Error("ByteRingBuffer maxBytes must be positive");
    }
  }

  /** 追加一段输出；超限时从头部丢弃整段，直到总字节数回到上限内。 */
  append(data: string | Buffer): void {
    const chunk = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    if (chunk.byteLength === 0) {
      return;
    }
    if (chunk.byteLength >= this.maxBytes) {
      while (this.segmentCount() > 0) {
        this.dropFirstSegment();
      }
      if (chunk.byteLength > this.maxBytes) {
        this.onEvict?.(chunk.subarray(0, chunk.byteLength - this.maxBytes));
      }
      this.clear();
      this.write(chunk.subarray(chunk.byteLength - this.maxBytes));
      return;
    }
    this.write(chunk);
    while (this.totalBytes > this.maxBytes && this.segmentCount() > 0) {
      this.dropFirstSegment();
    }
  }

  /** 按写入顺序拼接为 UTF-8 字符串（截断边界可能落在多字节字符中间，调用方按字节语义使用）。 */
  toString(): string {
    if (this.totalBytes === 0) {
      return "";
    }
    return this.copyOut(this.totalBytes).toString("utf8");
  }

  /** 最后至多 maxBytes 字节，开头落在多字节字符中间时往后挪到字符边界。不拼整份。 */
  tailString(maxBytes: number): string {
    const take = Math.min(Math.max(0, Math.floor(maxBytes)), this.totalBytes);
    if (take === 0) {
      return "";
    }
    const all = this.totalBytes;
    const out = Buffer.allocUnsafe(take);
    let skip = all - take;
    let written = 0;
    let start = this.head;
    for (let index = 0; index < this.blocks.length && written < take; index += 1) {
      const block = this.blocks[index];
      if (block === undefined) {
        break;
      }
      const end = index === this.blocks.length - 1 ? this.tailUsed : block.byteLength;
      const available = end - start;
      if (skip >= available) {
        skip -= available;
        start = 0;
        continue;
      }
      const from = start + skip;
      skip = 0;
      const count = Math.min(end - from, take - written);
      block.copy(out, written, from, from + count);
      written += count;
      start = 0;
    }
    let first = 0;
    if (take < all) {
      while (first < out.byteLength && ((out[first] ?? 0) & 0xc0) === 0x80) {
        first += 1;
      }
    }
    return out.subarray(first).toString("utf8");
  }

  byteLength(): number {
    return this.totalBytes;
  }

  clear(): void {
    this.blocks = [];
    this.head = 0;
    this.tailUsed = 0;
    this.lengths = [];
    this.lengthsHead = 0;
    this.totalBytes = 0;
  }

  private segmentCount(): number {
    return this.lengths.length - this.lengthsHead;
  }

  private write(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.byteLength) {
      let block = this.blocks[this.blocks.length - 1];
      if (block === undefined || this.tailUsed === block.byteLength) {
        block = Buffer.allocUnsafeSlow(BLOCK_BYTES);
        this.blocks.push(block);
        this.tailUsed = 0;
      }
      const copied = chunk.copy(block, this.tailUsed, offset);
      this.tailUsed += copied;
      offset += copied;
    }
    this.lengths.push(chunk.byteLength);
    this.totalBytes += chunk.byteLength;
  }

  /** 从头部拷出 length 字节（不改状态）。 */
  private copyOut(length: number): Buffer {
    const out = Buffer.allocUnsafe(length);
    let written = 0;
    let start = this.head;
    for (let index = 0; index < this.blocks.length && written < length; index += 1) {
      const block = this.blocks[index];
      if (block === undefined) {
        break;
      }
      const end = index === this.blocks.length - 1 ? this.tailUsed : block.byteLength;
      const take = Math.min(end - start, length - written);
      block.copy(out, written, start, start + take);
      written += take;
      start = 0;
    }
    return out;
  }

  private dropFirstSegment(): void {
    const length = this.lengths[this.lengthsHead] ?? 0;
    if (this.onEvict !== undefined) {
      this.onEvict(this.copyOut(length));
    }
    this.lengthsHead += 1;
    this.totalBytes -= length;
    this.head += length;
    while (this.blocks.length > 0) {
      const first = this.blocks[0];
      const end = this.blocks.length === 1 ? this.tailUsed : (first?.byteLength ?? 0);
      if (this.head < end) {
        break;
      }
      if (this.blocks.length === 1) {
        this.blocks = [];
        this.head = 0;
        this.tailUsed = 0;
        break;
      }
      this.head -= end;
      this.blocks.shift();
    }
    if (this.lengthsHead > 1024 && this.lengthsHead * 2 > this.lengths.length) {
      this.lengths = this.lengths.slice(this.lengthsHead);
      this.lengthsHead = 0;
    }
  }
}
