/**
 * 全局快捷键注册表（W3.1c）——设计系统 §7 的可执行副本。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 一、19 条从哪来（拆分规则，别当魔数）
 * ════════════════════════════════════════════════════════════════════════════
 * §7 表格 16 行，本注册表按 **一个「命令 × 作用域」一条** 展开：
 *   - `Alt+←` / `Alt+→`        → 后退、前进 2 条（两个命令）
 *   - `↑` / `↓`                → 上移、下移 2 条（两个命令）
 *   - `Ctrl+Shift+A`           → 任务接受、记忆候选通过 2 条（同键位、两个作用域）
 *   - `Ctrl+1` ~ `Ctrl+7`      → 1 条（同一个"按序号切页"命令，7 个键位）
 * 16 + 1 + 1 + 1 = **19**。`Ctrl+Enter` 在 §7 本来就分两行（会话发送 / 任务派发），
 * 同键位不同作用域不算冲突——这是本表的既有先例。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 二、作用域与优先级
 * ════════════════════════════════════════════════════════════════════════════
 * 全局键位优先级最高，页面工单不得覆盖（§7 冲突规则）：注册时同键位撞上全局键位
 * 直接抛 ShortcutConflictError，运行时 resolve() 也优先返回全局条目。
 * 非全局作用域必须由页面上报（command/useCommandPalette.ts 的 useShortcutScope），
 * 未上报的作用域内的键位不会触发。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 三、输入框内失效
 * ════════════════════════════════════════════════════════════════════════════
 * 无修饰键的键位（`/`、`↑`、`↓`、`Enter`）在输入框/文本域内一律失效（§6.4），
 * 唯一例外是 `Esc`——它的作用本身包含"取消当前编辑"。
 * 判定用 isTextInputTarget()：结构化取 tagName/type/readOnly/isContentEditable，
 * 不依赖 DOM 类型，因此本文件可在 node 环境直接单测。
 *
 * 新增键位：先改 docs/设计系统.md §7，再改本表，再补两个语言包。
 */
import type { CommandId } from "./ids";

export const SHORTCUT_SCOPES = [
  /** 全应用生效，页面不得覆盖。 */
  "global",
  /** 当前页面（任意页面都可上报）。 */
  "page",
  /** 列表获得焦点时。 */
  "list",
  /** 会话页。 */
  "session",
  /** 会话页的输入框内。 */
  "session-input",
  /** 任务页。 */
  "tasks",
  /** 记忆页的待审核候选标签。 */
  "memory-review",
] as const;

export type ShortcutScope = (typeof SHORTCUT_SCOPES)[number];

/** 规范化后的键位组合。 */
export interface KeyChord {
  /** KeyboardEvent.key 的小写形式（"k" / "escape" / "arrowleft" / "," …）。 */
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

/** KeyboardEvent 的最小结构（不引用 DOM 类型，便于单测与跨 lib 复用）。 */
export interface KeyboardEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

/** 一条快捷键登记（§7 表格的一行 = 一个命令 × 一个作用域）。 */
export interface ShortcutRegistration {
  readonly commandId: CommandId;
  /** 键位串，如 "Ctrl+K"、"Ctrl+ArrowLeft"、"Escape"；多键位见 nav-page-by-index。 */
  readonly keys: readonly string[];
  readonly scopes: readonly ShortcutScope[];
  /** 输入框/文本域内是否失效（§6.4）。 */
  readonly disabledInTextInput: boolean;
  /**
   * 命中后是否吃掉事件（preventDefault + stopPropagation）。
   * Esc 为 false：最上层浮层的关闭由 radix / 页面自己处理，全局层不能抢。
   */
  readonly preventDefault: boolean;
}

/** 展开到单个键位的绑定（注册表内部索引单位）。 */
export interface ShortcutBinding {
  readonly chord: KeyChord;
  /** 规范化匹配键（"ctrl+shift+a"），冲突检测与查表都用它。 */
  readonly chordId: string;
  /** 展示串（"Ctrl+Shift+A" / "Alt+←" / "Esc"），命令面板与 tooltip 用。 */
  readonly display: string;
  readonly registration: ShortcutRegistration;
}

export interface ShortcutMatch {
  readonly registration: ShortcutRegistration;
  readonly binding: ShortcutBinding;
}

export interface ShortcutResolveContext {
  readonly event: KeyboardEventLike;
  /** 当前激活的作用域（"global" 恒定生效，不必上报）。 */
  readonly activeScopes: readonly ShortcutScope[];
  /** 事件源是否为输入框/文本域。 */
  readonly inTextInput: boolean;
}

/** 键位冲突：同一键位在相交的作用域上被注册两次，或试图覆盖全局键位。 */
export class ShortcutConflictError extends Error {
  readonly chordId: string;
  readonly existingCommandId: CommandId;
  readonly incomingCommandId: CommandId;

  constructor(chordId: string, existingCommandId: CommandId, incomingCommandId: CommandId) {
    super(
      `shortcut conflict on "${chordId}": "${incomingCommandId}" collides with "${existingCommandId}"`,
    );
    this.name = "ShortcutConflictError";
    this.chordId = chordId;
    this.existingCommandId = existingCommandId;
    this.incomingCommandId = incomingCommandId;
  }
}

const MODIFIER_ALIASES: Readonly<Record<string, "ctrl" | "alt" | "shift" | "meta">> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  meta: "meta",
  cmd: "meta",
  command: "meta",
};

/** 命名键的展示形式（未列出的单字符键按大写展示）。 */
const KEY_DISPLAY: Readonly<Record<string, string>> = {
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Del",
  arrowleft: "\u2190",
  arrowright: "\u2192",
  arrowup: "\u2191",
  arrowdown: "\u2193",
  " ": "Space",
};

/**
 * 把 KeyboardEvent.key 规范化为匹配用的小写形式。
 * 小写化让「Ctrl+Shift+A」这类组合可比较：按下 Shift 时浏览器给的 key 是 "A"，
 * 而键位表里写的是 "a"，不统一大小写就永远匹配不上。
 */
export function normalizeEventKey(key: string): string {
  return key.toLowerCase();
}

/** 解析键位串（"Ctrl+Shift+A"）；修饰键名非法或缺少主键时抛错。 */
export function parseKeyChord(spec: string): KeyChord {
  const segments = spec
    .split("+")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const mainKey = segments.pop();
  if (mainKey === undefined) {
    throw new Error(`invalid shortcut spec: "${spec}"`);
  }
  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  for (const segment of segments) {
    const modifier = MODIFIER_ALIASES[segment.toLowerCase()];
    if (modifier === undefined) {
      throw new Error(`unknown shortcut modifier "${segment}" in "${spec}"`);
    }
    if (modifier === "ctrl") {
      ctrl = true;
    } else if (modifier === "alt") {
      alt = true;
    } else if (modifier === "shift") {
      shift = true;
    } else {
      meta = true;
    }
  }
  return { key: normalizeEventKey(mainKey), ctrl, alt, shift, meta };
}

/** 规范化匹配键：修饰键固定顺序 + 小写主键。 */
export function chordId(chord: KeyChord): string {
  return [
    chord.ctrl ? "ctrl" : "",
    chord.alt ? "alt" : "",
    chord.shift ? "shift" : "",
    chord.meta ? "meta" : "",
    chord.key,
  ]
    .filter((part) => part.length > 0)
    .join("+");
}

/** 展示串：键位提示、命令面板右侧、按钮 tooltip 都用这个（font-mono 呈现）。 */
export function formatKeyChord(chord: KeyChord): string {
  const named = KEY_DISPLAY[chord.key];
  const main = named ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  const parts: string[] = [];
  if (chord.ctrl) {
    parts.push("Ctrl");
  }
  if (chord.alt) {
    parts.push("Alt");
  }
  if (chord.shift) {
    parts.push("Shift");
  }
  if (chord.meta) {
    parts.push("Meta");
  }
  parts.push(main);
  return parts.join("+");
}

/** 键位串 → 展示串（快捷键表直接给字符串时用）。 */
export function formatShortcutSpec(spec: string): string {
  return formatKeyChord(parseKeyChord(spec));
}

/** 事件 → 规范化匹配键。 */
export function chordIdFromEvent(event: KeyboardEventLike): string {
  return chordId({
    key: normalizeEventKey(event.key),
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  });
}

/** 事件源的最小结构（真实 DOM 元素可直接传入）。 */
export interface TextInputTargetLike {
  readonly tagName?: string | undefined;
  readonly type?: string | undefined;
  readonly readOnly?: boolean | undefined;
  readonly isContentEditable?: boolean | undefined;
}

const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "",
  "text",
  "search",
  "email",
  "password",
  "url",
  "tel",
  "number",
]);

/**
 * 是否为「文本输入」上下文：input[文本类] / textarea / contenteditable。
 * 只读控件不算（只读路径/ID 要能被选中复制，单字母键仍应生效）；
 * select 与勾选/按钮类 input 不算文本输入。
 */
export function isTextInputTarget(target: TextInputTargetLike | null | undefined): boolean {
  if (target === null || target === undefined) {
    return false;
  }
  if (target.isContentEditable === true) {
    return true;
  }
  const tag = target.tagName?.toLowerCase();
  if (tag === "textarea") {
    return target.readOnly !== true;
  }
  if (tag !== "input") {
    return false;
  }
  const type = (target.type ?? "").toLowerCase();
  return TEXT_INPUT_TYPES.has(type) && target.readOnly !== true;
}

/**
 * 设计系统 §7 快捷键表（19 条）。
 * 未实现的动作在这里只登记 commandId：命令面板会把它显示为「待接入」，
 * 页面工单挂上 handler 之后立即生效，无需回来改本表。
 */
export const SHORTCUT_TABLE: readonly ShortcutRegistration[] = [
  {
    commandId: "palette-open",
    keys: ["Ctrl+K"],
    scopes: ["global"],
    disabledInTextInput: false,
    preventDefault: true,
  },
  {
    commandId: "palette-projects",
    keys: ["Ctrl+P"],
    scopes: ["global"],
    disabledInTextInput: false,
    preventDefault: true,
  },
  {
    commandId: "settings-open",
    keys: ["Ctrl+,"],
    scopes: ["global"],
    disabledInTextInput: false,
    preventDefault: true,
  },
  {
    commandId: "help-shortcuts",
    keys: ["Ctrl+/"],
    scopes: ["global"],
    disabledInTextInput: false,
    preventDefault: true,
  },
  {
    commandId: "app-dismiss",
    keys: ["Escape"],
    scopes: ["global"],
    // Esc 在输入框内必须仍然生效（"取消当前编辑"），也不能吃掉事件：
    // 最上层浮层的关闭归 radix / 页面自己
    disabledInTextInput: false,
    preventDefault: false,
  },
  {
    commandId: "nav-back",
    keys: ["Alt+ArrowLeft"],
    scopes: ["global"],
    disabledInTextInput: false,
    preventDefault: true,
  },
  {
    commandId: "nav-forward",
    keys: ["Alt+ArrowRight"],
    scopes: ["global"],
    disabledInTextInput: false,
    preventDefault: true,
  },
  {
    commandId: "nav-page-by-index",
    keys: ["Ctrl+1", "Ctrl+2", "Ctrl+3", "Ctrl+4", "Ctrl+5", "Ctrl+6", "Ctrl+7"],
    scopes: ["global"],
    disabledInTextInput: false,
    preventDefault: true,
  },
  {
    commandId: "page-focus-search",
    keys: ["/"],
    scopes: ["page"],
    disabledInTextInput: true,
    preventDefault: true,
  },
  {
    commandId: "list-move-up",
    keys: ["ArrowUp"],
    scopes: ["list"],
    disabledInTextInput: true,
    preventDefault: true,
  },
  {
    commandId: "list-move-down",
    keys: ["ArrowDown"],
    scopes: ["list"],
    disabledInTextInput: true,
    preventDefault: true,
  },
  {
    commandId: "list-open",
    keys: ["Enter"],
    scopes: ["list"],
    disabledInTextInput: true,
    preventDefault: true,
  },
  {
    commandId: "session-send",
    keys: ["Ctrl+Enter"],
    scopes: ["session-input"],
    disabledInTextInput: false,
    preventDefault: true,
  },
  {
    commandId: "session-insert-knowledge",
    keys: ["Ctrl+I"],
    scopes: ["session"],
    disabledInTextInput: false,
    preventDefault: true,
  },
  {
    commandId: "session-switch-role",
    keys: ["Ctrl+Shift+R"],
    scopes: ["session"],
    disabledInTextInput: false,
    preventDefault: true,
  },
  {
    commandId: "tasks-dispatch",
    keys: ["Ctrl+Enter"],
    scopes: ["tasks"],
    disabledInTextInput: false,
    preventDefault: true,
  },
  {
    commandId: "tasks-accept",
    keys: ["Ctrl+Shift+A"],
    scopes: ["tasks"],
    disabledInTextInput: false,
    preventDefault: true,
  },
  {
    commandId: "memory-approve",
    keys: ["Ctrl+Shift+A"],
    scopes: ["memory-review"],
    disabledInTextInput: false,
    preventDefault: true,
  },
  {
    commandId: "memory-reject",
    keys: ["Ctrl+Shift+X"],
    scopes: ["memory-review"],
    disabledInTextInput: false,
    preventDefault: true,
  },
];

/** §7 表格行数（= 本注册表条目数），拆分规则见文件头注。 */
export const SHORTCUT_TABLE_SIZE = 19;

export interface ShortcutRegistry {
  /** 注册一条；键位冲突抛 ShortcutConflictError。 */
  readonly register: (registration: ShortcutRegistration) => void;
  readonly entries: () => readonly ShortcutRegistration[];
  readonly bindings: () => readonly ShortcutBinding[];
  /** 按当前事件与作用域解析命中项；无命中返回 undefined。 */
  readonly resolve: (context: ShortcutResolveContext) => ShortcutMatch | undefined;
  /** 取某命令的登记（同命令只允许一条）。 */
  readonly byCommandId: (commandId: CommandId) => ShortcutRegistration | undefined;
  /** 某命令的键位展示串（多键位以 " / " 连接；无登记返回 undefined）。 */
  readonly displayFor: (commandId: CommandId) => string | undefined;
}

function scopesOverlap(left: readonly ShortcutScope[], right: readonly ShortcutScope[]): boolean {
  return left.some((scope) => right.includes(scope));
}

/**
 * 两条登记是否冲突：同键位且（作用域相交 或 任一方是全局）。
 * 后半句就是 §7 的「全局键位优先级最高，页面工单不得覆盖」——
 * 页面想在全局键位上另立山头，注册阶段就失败。
 */
function conflicts(existing: ShortcutRegistration, incoming: ShortcutRegistration): boolean {
  return (
    scopesOverlap(existing.scopes, incoming.scopes) ||
    existing.scopes.includes("global") ||
    incoming.scopes.includes("global")
  );
}

export function createShortcutRegistry(
  initial: readonly ShortcutRegistration[] = [],
): ShortcutRegistry {
  const registrations: ShortcutRegistration[] = [];
  const allBindings: ShortcutBinding[] = [];
  const byChord = new Map<string, ShortcutBinding[]>();

  const register = (registration: ShortcutRegistration): void => {
    if (registration.keys.length === 0) {
      throw new Error(`shortcut "${registration.commandId}" registers no key`);
    }
    if (registration.scopes.length === 0) {
      throw new Error(`shortcut "${registration.commandId}" registers no scope`);
    }
    if (registrations.some((entry) => entry.commandId === registration.commandId)) {
      throw new Error(`shortcut command already registered: "${registration.commandId}"`);
    }
    const pending: ShortcutBinding[] = registration.keys.map((spec) => {
      const chord = parseKeyChord(spec);
      return {
        chord,
        chordId: chordId(chord),
        display: formatKeyChord(chord),
        registration,
      };
    });
    for (const binding of pending) {
      const existing = byChord.get(binding.chordId) ?? [];
      const collision = existing.find((entry) => conflicts(entry.registration, registration));
      if (collision !== undefined) {
        throw new ShortcutConflictError(
          binding.chordId,
          collision.registration.commandId,
          registration.commandId,
        );
      }
    }
    registrations.push(registration);
    for (const binding of pending) {
      allBindings.push(binding);
      const bucket = byChord.get(binding.chordId);
      if (bucket === undefined) {
        byChord.set(binding.chordId, [binding]);
      } else {
        bucket.push(binding);
      }
    }
  };

  for (const registration of initial) {
    register(registration);
  }

  const byCommandId = (commandId: CommandId): ShortcutRegistration | undefined =>
    registrations.find((entry) => entry.commandId === commandId);

  return {
    register,
    entries: () => registrations,
    bindings: () => allBindings,
    byCommandId,
    displayFor: (commandId) => {
      const bindings = allBindings.filter(
        (binding) => binding.registration.commandId === commandId,
      );
      if (bindings.length === 0) {
        return undefined;
      }
      return bindings.map((binding) => binding.display).join(" / ");
    },
    resolve: (context) => {
      const candidates = byChord.get(chordIdFromEvent(context.event)) ?? [];
      const eligible = candidates.filter((binding) => {
        if (context.inTextInput && binding.registration.disabledInTextInput) {
          return false;
        }
        return binding.registration.scopes.some(
          (scope) => scope === "global" || context.activeScopes.includes(scope),
        );
      });
      // 全局优先（§7 冲突规则），其余按注册顺序
      const chosen =
        eligible.find((binding) => binding.registration.scopes.includes("global")) ?? eligible[0];
      if (chosen === undefined) {
        return undefined;
      }
      return { registration: chosen.registration, binding: chosen };
    },
  };
}
