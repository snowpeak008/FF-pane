/**
 * 终端模式记账：回放缓冲按字节截掉开头时，截掉的那段里设过的终端模式也跟着丢了。
 * 典型是 Claude Code 只在启动时发一次 `ESC[?25l` 藏起真光标：会话输出超过缓冲上限后，
 * 切标签回来重放，新的 xterm 回到默认的「光标可见、闪烁」，Claude 每画一处光标就跳到哪，
 * 输入法的输入位置也跟着乱跳（2026-10-20 实录复现）。
 * 所以被截掉的输出先过一遍这里，只记 DEC 私有模式（CSI ? Pm h / l）的最后取值，
 * 回放时把它们放在剩余输出前面，重放完的状态就和不截断时一样。
 */

/** 回放时要还原的 DEC 私有模式：光标键、原点、自动换行、光标显隐、备用屏、鼠标、焦点、括号粘贴。 */
const TRACKED_MODES: ReadonlySet<number> = new Set([
  1, 6, 7, 25, 47, 66, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 1047, 1049, 2004,
]);

/** 半截序列最多留这么长，超过就当不是模式序列丢掉。 */
const MAX_CARRY = 64;

const ESC = String.fromCharCode(0x1b);

/** CSI ? Pm h / l；ESC 不直接写进正则字面量。 */
const MODE_SEQUENCE = new RegExp(`${ESC}\\[\\?([0-9;]*)([hl])`, "g");

/** ESC 之后的半截模式序列：`[`、`[?`、`[?25` 这类。 */
const PARTIAL_MODE_TAIL = /^(\[(\?[0-9;]*)?)?$/;

export class TerminalModeState {
  /** 模式号 → 是否打开；按最后一次设置的先后排，回放时互斥的鼠标模式也是后设的生效。 */
  private readonly modes = new Map<number, boolean>();
  private carry = "";

  feed(data: string): void {
    const text = this.carry + data;
    this.carry = "";
    let consumed = 0;
    for (const match of text.matchAll(MODE_SEQUENCE)) {
      const enabled = match[2] === "h";
      for (const part of (match[1] ?? "").split(";")) {
        const mode = Number(part);
        if (part !== "" && TRACKED_MODES.has(mode)) {
          this.modes.delete(mode);
          this.modes.set(mode, enabled);
        }
      }
      consumed = (match.index ?? 0) + match[0].length;
    }
    const tailStart = text.lastIndexOf(ESC);
    if (
      tailStart >= consumed &&
      text.length - tailStart <= MAX_CARRY &&
      PARTIAL_MODE_TAIL.test(text.slice(tailStart + 1))
    ) {
      this.carry = text.slice(tailStart);
    }
  }

  /** 还原这些模式的序列；没记到任何模式时为空串。 */
  prelude(): string {
    let out = "";
    for (const [mode, enabled] of this.modes) {
      out += `\x1b[?${mode}${enabled ? "h" : "l"}`;
    }
    return out;
  }
}
