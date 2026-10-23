/**
 * 终端应答闸门：只放行「CLI 刚问过、很快就回来」的终端应答。
 *
 * CLI 启动时会问终端「你是什么终端」「前景、背景是什么颜色」（DA1、OSC 10/11 等），
 * 界面上的 xterm 收到问题就自动应答，应答经 terminal:write 写回 PTY。
 * 窗格重挂载（切标签、最大化、开子窗口把格子一分为二、平台重启后接回）时，
 * 回放缓冲里的旧问题会被 xterm 再答一遍，这时 CLI 早就不等了：
 * Codex 把应答开头的 ESC 当成 Esc 键，打断正在跑的一轮，剩下的
 * `[?1;2c]10;rgb:…\]11;rgb:…\` 落进输入框，下一次回车被当成用户消息提交
 * （2026-10-23 监管者窗口实录，codex-cli 0.162.0）。
 *
 * 做法：看 PTY 输出里出现了哪些问题，各记一个到期时间；界面写回来的应答按种类配对，
 * 有没到期的问题就放行并销掉一个，没有就丢掉。同一个问题被答两遍，第二遍也丢掉。
 * 只管界面写回来的那一路，平台自己写的按键（投递正文、Esc）不经过这里。
 */

const ESC = "\u001b";
const BEL = "\u0007";

/** 问题发出后多久内的应答算数。xterm 正常几十毫秒内就答，留足余量。 */
export const TERMINAL_REPLY_WINDOW_MS = 3000;

/** 同一种问题最多记这么多个，防止一直发问的程序把表撑大。 */
const MAX_PENDING_PER_KIND = 16;

/** 半截问题最多留这么长。 */
const MAX_CARRY = 32;

type ReplyKind = "da1" | "da2" | "cpr" | "status" | "osc" | "decrqm" | "kitty" | "winop";

interface QueryPattern {
  readonly kind: ReplyKind;
  readonly pattern: RegExp;
  /** OSC 按编号分开配对：问了背景色，不能放行前景色的旧应答。 */
  readonly key?: (match: RegExpMatchArray) => string;
}

const ST = `(?:${BEL}|${ESC}\\\\)`;

/** PTY 输出里的问题。 */
const QUERIES: readonly QueryPattern[] = [
  { kind: "da1", pattern: new RegExp(`${ESC}\\[0?c`, "g") },
  { kind: "da2", pattern: new RegExp(`${ESC}\\[>0?c`, "g") },
  { kind: "cpr", pattern: new RegExp(`${ESC}\\[\\??6n`, "g") },
  { kind: "status", pattern: new RegExp(`${ESC}\\[5n`, "g") },
  {
    kind: "osc",
    pattern: new RegExp(`${ESC}\\](1[0-9]|4;\\d+);\\?${ST}`, "g"),
    key: (match) => oscKey(match[1] ?? ""),
  },
  { kind: "decrqm", pattern: new RegExp(`${ESC}\\[\\??\\d+\\$p`, "g") },
  { kind: "kitty", pattern: new RegExp(`${ESC}\\[\\?u`, "g") },
  { kind: "winop", pattern: new RegExp(`${ESC}\\[1[468]t`, "g") },
];

/** 界面写回来的应答。按出现先后一起扫，所以合成一个正则。 */
const REPLY = new RegExp(
  [
    `(?<da1>${ESC}\\[\\?[\\d;]*c)`,
    `(?<da2>${ESC}\\[>[\\d;]*c)`,
    `(?<cpr>${ESC}\\[\\??\\d+;\\d+R)`,
    `(?<status>${ESC}\\[0n)`,
    `(?<osc>${ESC}\\](1[0-9]|4;\\d+);rgb:[0-9a-fA-F/]*${ST})`,
    `(?<decrqm>${ESC}\\[\\??\\d+;\\d+\\$y)`,
    `(?<kitty>${ESC}\\[\\?\\d+u)`,
    `(?<winop>${ESC}\\[[468];\\d+;\\d+t)`,
  ].join("|"),
  "g",
);

const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

function oscKey(code: string): string {
  return code.startsWith("4;") ? "4" : code;
}

export interface ReplyFilterResult {
  /** 该写进 PTY 的内容：用户按键 + 放行的应答。 */
  readonly data: string;
  /** 除去所有应答后剩下的用户按键，用来记「用户有输入」「用户按了回车」。 */
  readonly typed: string;
  /** 丢掉了几段过期或重复的应答。 */
  readonly dropped: number;
}

export class TerminalReplyGate {
  private readonly pending = new Map<string, number[]>();
  private carry = "";

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly windowMs: number = TERMINAL_REPLY_WINDOW_MS,
  ) {}

  /** 记下 PTY 输出里的问题。 */
  noteOutput(data: string): void {
    const text = this.carry + data;
    const fresh = this.carry.length;
    const expires = this.now() + this.windowMs;
    for (const query of QUERIES) {
      for (const match of text.matchAll(query.pattern)) {
        // 整个落在上次留下的半截里：上次已经算过。
        if ((match.index ?? 0) + match[0].length <= fresh) {
          continue;
        }
        this.push(slot(query.kind, query.key?.(match)), expires);
      }
    }
    const tail = text.lastIndexOf(ESC);
    this.carry = tail >= 0 && text.length - tail <= MAX_CARRY ? text.slice(tail) : "";
  }

  /** 过一遍界面写回来的内容。括号粘贴里的不动。 */
  filterInput(data: string): ReplyFilterResult {
    if (!data.includes(ESC)) {
      return { data, typed: data, dropped: 0 };
    }
    let out = "";
    let typed = "";
    let dropped = 0;
    let rest = data;
    while (rest.length > 0) {
      const pasteAt = rest.indexOf(PASTE_START);
      const plain = pasteAt < 0 ? rest : rest.slice(0, pasteAt);
      const scanned = this.scan(plain);
      out += scanned.data;
      typed += scanned.typed;
      dropped += scanned.dropped;
      if (pasteAt < 0) {
        break;
      }
      const endAt = rest.indexOf(PASTE_END, pasteAt);
      const pasteStop = endAt < 0 ? rest.length : endAt + PASTE_END.length;
      const paste = rest.slice(pasteAt, pasteStop);
      out += paste;
      typed += paste;
      rest = rest.slice(pasteStop);
    }
    return { data: out, typed, dropped };
  }

  private scan(text: string): ReplyFilterResult {
    let out = "";
    let typed = "";
    let dropped = 0;
    let last = 0;
    for (const match of text.matchAll(REPLY)) {
      const at = match.index ?? 0;
      const between = text.slice(last, at);
      out += between;
      typed += between;
      last = at + match[0].length;
      const kind = replyKind(match);
      if (kind !== undefined && this.take(kind)) {
        out += match[0];
      } else {
        dropped += 1;
      }
    }
    const tail = text.slice(last);
    return { data: out + tail, typed: typed + tail, dropped };
  }

  private push(key: string, expires: number): void {
    const list = this.pending.get(key) ?? [];
    list.push(expires);
    if (list.length > MAX_PENDING_PER_KIND) {
      list.shift();
    }
    this.pending.set(key, list);
  }

  /** 有没到期的同类问题就销掉最早的一个。 */
  private take(key: string): boolean {
    const list = this.pending.get(key);
    if (list === undefined) {
      return false;
    }
    const now = this.now();
    while (list.length > 0 && (list[0] ?? 0) < now) {
      list.shift();
    }
    if (list.length === 0) {
      this.pending.delete(key);
      return false;
    }
    list.shift();
    return true;
  }
}

function slot(kind: ReplyKind, key: string | undefined): string {
  return key === undefined ? kind : `${kind}:${key}`;
}

function replyKind(match: RegExpMatchArray): string | undefined {
  const groups = match.groups ?? {};
  for (const kind of ["da1", "da2", "cpr", "status", "decrqm", "kitty", "winop"] as const) {
    if (groups[kind] !== undefined) {
      return kind;
    }
  }
  if (groups["osc"] !== undefined) {
    const code = /\](1[0-9]|4;\d+);/.exec(groups["osc"])?.[1] ?? "";
    return slot("osc", oscKey(code));
  }
  return undefined;
}
