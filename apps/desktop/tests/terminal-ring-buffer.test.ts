/**
 * T11.0d：终端输出缓冲拷进 64KB 块存，截断仍按整段丢。
 */

import { describe, expect, it } from "vitest";
import { ByteRingBuffer } from "../src/main/terminal/ring-buffer";

describe("ByteRingBuffer 块存储", () => {
  it("跨块写入后内容和顺序不变", () => {
    const buffer = new ByteRingBuffer(1024 * 1024);
    const parts: string[] = [];
    for (let index = 0; index < 5000; index += 1) {
      const part = `line ${index} ${"x".repeat(index % 97)}\n`;
      parts.push(part);
      buffer.append(part);
    }
    const expected = parts.join("");
    expect(buffer.byteLength()).toBe(Buffer.byteLength(expected));
    expect(buffer.toString()).toBe(expected);
  });

  it("超限时按整段从头丢，剩下的正好是最后几段", () => {
    const evicted: string[] = [];
    const buffer = new ByteRingBuffer(100_000, (dropped) => evicted.push(dropped.toString()));
    const parts: string[] = [];
    for (let index = 0; index < 20_000; index += 1) {
      const part = `${index}:${"y".repeat(index % 31)};`;
      parts.push(part);
      buffer.append(part);
    }
    expect(buffer.byteLength()).toBeLessThanOrEqual(100_000);
    const kept = buffer.toString();
    expect(evicted.join("") + kept).toBe(parts.join(""));
    expect(parts.some((part) => kept.startsWith(part))).toBe(true);
  });

  it("多字节字符跨块不坏", () => {
    const buffer = new ByteRingBuffer(1024 * 1024);
    const text = "终端输出😀".repeat(20_000);
    buffer.append(text);
    buffer.append("尾巴");
    expect(buffer.toString()).toBe(`${text}尾巴`);
  });

  it("一段比上限还大：只留最后 max 字节，前面的交给 onEvict", () => {
    const evicted: string[] = [];
    const buffer = new ByteRingBuffer(10, (dropped) => evicted.push(dropped.toString()));
    buffer.append("abc");
    buffer.append("0123456789ABCDEF");
    expect(evicted).toEqual(["abc", "012345"]);
    expect(buffer.toString()).toBe("6789ABCDEF");
    buffer.append("Z");
    expect(evicted).toEqual(["abc", "012345", "6789ABCDEF"]);
    expect(buffer.toString()).toBe("Z");
  });

  it("clear 后从空开始", () => {
    const buffer = new ByteRingBuffer(16);
    buffer.append("hello");
    buffer.clear();
    expect(buffer.byteLength()).toBe(0);
    expect(buffer.toString()).toBe("");
    buffer.append("again");
    expect(buffer.toString()).toBe("again");
  });
});

describe("ByteRingBuffer.tailString", () => {
  it("和整份拼出来再取尾巴一样", () => {
    const buffer = new ByteRingBuffer(300_000);
    let all = "";
    for (let index = 0; index < 30_000; index += 1) {
      const part = index % 7 === 0 ? `中文${index}` : `ascii-${index};`;
      all += part;
      buffer.append(part);
    }
    const whole = buffer.toString();
    for (const max of [1, 2, 3, 100, 65_536, 65_537, 200_000, 299_999, 300_000, 400_000]) {
      const bytes = Buffer.from(whole, "utf8");
      let start = Math.max(0, bytes.byteLength - max);
      while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) {
        start += 1;
      }
      expect(buffer.tailString(max)).toBe(bytes.subarray(start).toString("utf8"));
    }
    expect(all.endsWith(buffer.tailString(50))).toBe(true);
  });

  it("空缓冲和 0 字节", () => {
    const buffer = new ByteRingBuffer(10);
    expect(buffer.tailString(5)).toBe("");
    buffer.append("abc");
    expect(buffer.tailString(0)).toBe("");
    expect(buffer.tailString(10)).toBe("abc");
  });
});
