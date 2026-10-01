/**
 * 终端回放尾部（T10.7b）：按字节截取，再去掉 ANSI / 控制序列。
 * 默认 8KB，调用方可调，硬顶 32KB。
 */

export const READ_OUTPUT_DEFAULT_BYTES = 8 * 1024;
export const READ_OUTPUT_MAX_BYTES = 32 * 1024;

export function clampReadOutputBytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return READ_OUTPUT_DEFAULT_BYTES;
  }
  const floored = Math.floor(value);
  if (floored < 1) {
    return READ_OUTPUT_DEFAULT_BYTES;
  }
  return Math.min(floored, READ_OUTPUT_MAX_BYTES);
}

/** 取 UTF-8 尾部。截断点若落在续字节上，向后挪到下一个字符边界。 */
export function takeUtf8Tail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) {
    return text;
  }
  let start = buf.byteLength - maxBytes;
  while (start < buf.byteLength && ((buf[start] ?? 0) & 0xc0) === 0x80) {
    start += 1;
  }
  return buf.subarray(start).toString("utf8");
}

/**
 * 去掉 CSI、OSC、其它 ESC 序列，以及除 TAB / LF / CR 以外的 C0 与 DEL。
 * 不解释颜色，只留下可放进工具结果的文本。
 */
export function stripTerminalControls(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x1b) {
      const nextIndex = index + 1;
      if (nextIndex >= text.length) {
        break;
      }
      const next = text.charCodeAt(nextIndex);
      if (next === 0x5b) {
        index += 2;
        while (index < text.length) {
          const current = text.charCodeAt(index);
          if (current >= 0x40 && current <= 0x7e) {
            break;
          }
          index += 1;
        }
        continue;
      }
      if (next === 0x5d) {
        index += 2;
        while (index < text.length) {
          const current = text.charCodeAt(index);
          if (current === 0x07) {
            break;
          }
          if (current === 0x1b && text.charCodeAt(index + 1) === 0x5c) {
            index += 1;
            break;
          }
          index += 1;
        }
        continue;
      }
      index += 1;
      continue;
    }
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += text.charAt(index);
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      continue;
    }
    out += text.charAt(index);
  }
  return out;
}
