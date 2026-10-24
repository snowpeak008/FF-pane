/**
 * 终端回放尾部（T10.7b）：raw 模式按字节截取，再去掉 ANSI / 控制序列。
 * 默认 8KB，调用方可调，硬顶 32KB。
 * 屏幕模式（缺省）：用无头终端重放，返回渲染后的最近若干行，不含转圈动画的中间帧。
 */

import xtermHeadless from "@xterm/headless";

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

export const READ_SCREEN_DEFAULT_LINES = 60;
export const READ_SCREEN_MAX_LINES = 300;
const SCREEN_SCROLLBACK = 2000;
/** 只有加载动画字符、点和空白的行。 */
const SPINNER_ONLY = /^[\s.·•…⠀-⣿✢✳✶✻✽✺✹✸✷✵✴✱✲*◐◓◑◒|/-]*$/u;

export function clampReadScreenLines(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return READ_SCREEN_DEFAULT_LINES;
  }
  return Math.min(Math.floor(value), READ_SCREEN_MAX_LINES);
}

type HeadlessLine = NonNullable<ReturnType<xtermHeadless.Terminal["buffer"]["active"]["getLine"]>>;

/**
 * 只留正常显示的字：暗色和反色的格子换成空格。
 * 输入框的提示文字是暗色、光标格是反色（真机核对 Claude Code 2.1.302、codex-cli 0.162.0，2026-10-24），
 * 用户打的字是正常颜色。
 */
function solidText(line: HeadlessLine): string {
  let out = "";
  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x);
    const width = cell?.getWidth() ?? 1;
    if (cell === undefined || width === 0) {
      continue;
    }
    const chars = cell.getChars();
    out += chars === "" || cell.isDim() !== 0 || cell.isInverse() !== 0 ? " ".repeat(width) : chars;
  }
  return out.trimEnd();
}

/**
 * 把回放缓冲按终端尺寸重放进无头终端，取渲染后的屏幕和滚动区文字。
 * 光标移动、清行、重画都按终端语义落定，加载动画只留最后一帧；
 * 再去掉只剩动画字符的行，连续空行收成一行，返回最后 maxLines 行。
 * solidOnly：只留正常显示的字（见 solidText），用来判断输入框里有没有用户打的字。
 * keepRows：不把折行拼回去，按屏幕上的行返回。看输入框要用它：Windows ConPTY 遇到占满一整行的内容
 * （Claude 输入框上下的横线）不换行，靠自动折行接着写下一行，下一行会被标成折行，
 * 一拼就把横线和「❯」行拼成一行，认不出输入框（真机核对 Claude Code 2.1.302，2026-10-24）。
 */
export async function renderTerminalText(
  raw: string,
  size: { readonly cols: number; readonly rows: number },
  maxLines: number,
  options?: { readonly solidOnly?: boolean; readonly keepRows?: boolean },
): Promise<string> {
  const terminal = new xtermHeadless.Terminal({
    cols: Math.max(20, Math.floor(size.cols)),
    rows: Math.max(5, Math.floor(size.rows)),
    scrollback: SCREEN_SCROLLBACK,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((done) => {
      terminal.write(raw, () => done());
    });
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index);
      if (line === undefined) {
        continue;
      }
      const text = options?.solidOnly === true ? solidText(line) : line.translateToString(true);
      if (line.isWrapped && lines.length > 0 && options?.keepRows !== true) {
        lines[lines.length - 1] = `${lines[lines.length - 1]}${text}`;
        continue;
      }
      lines.push(text);
    }
    const kept: string[] = [];
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (trimmed !== "" && SPINNER_ONLY.test(trimmed)) {
        continue;
      }
      if (trimmed === "" && (kept.length === 0 || kept[kept.length - 1] === "")) {
        continue;
      }
      kept.push(trimmed);
    }
    while (kept.length > 0 && kept[kept.length - 1] === "") {
      kept.pop();
    }
    return kept.slice(Math.max(0, kept.length - maxLines)).join("\n");
  } finally {
    terminal.dispose();
  }
}
