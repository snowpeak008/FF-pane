/**
 * 从渲染后的屏幕看 CLI 是不是停在空闲的输入提示符上，顺带读出屏幕上显示的模型和思考强度。
 *
 * 只用来补回合信号的空缺：重启过的窗口还没跑过一轮，收不到 Stop；上一轮被 Esc 打断也没有 Stop。
 * 屏幕样子按真机核对（Claude Code 2.1.302、codex-cli 0.162.0，2026-10-21）：
 * - Claude：输入框是上下两条横线夹着的「❯ 」行；干活时上方有「… esc to interrupt」。
 *   信任目录、权限确认这类对话框的「❯ 1. Yes」「❯ No, exit」上面不是横线。
 *   开头横幅「Opus 5.5 with high effort · …」写着模型和强度。
 * - Codex：输入行是「› 」开头，下面一行是「GPT-6.1-Sol high · 目录」或「? for shortcuts」；
 *   干活时上方有「Working (2s • esc to interrupt)」；选择器的行是「› 1. …」，底下有「enter select · esc back」；
 *   还没启动好时打字会出现「Waiting for startup」。/model 选完会打出「Model changed to gpt-6-astra xhigh …」。
 *   有新版本时启动几秒后会弹「1. Update now / 2. Skip」，底下是「enter continue · esc skip」，也不算空闲。
 */

import type { DeliverPhase } from "./idle-deliver";

export type PromptRuntime = "claude-code" | "codex";

export interface PromptScreen {
  /** 停在空闲的输入提示符上。 */
  readonly ready: boolean;
  /** 屏幕上有在干活、在启动或在等选择的迹象。 */
  readonly busy: boolean;
  readonly model?: string;
  readonly effort?: string;
}

/** 只看屏幕最后这么多行。 */
const TAIL_LINES = 40;
/** 提示符应当在最后这么多行里。 */
const PROMPT_TAIL_LINES = 16;

const BUSY_MARKERS = [
  /esc to interrupt/i,
  /waiting for startup/i,
  /\bWorking \(/,
  /enter select/i,
  /enter continue/i,
  /esc skip/i,
  /esc back/i,
  /enter to confirm/i,
  /esc to cancel/i,
  /\bs session\b/i,
  /do you want to/i,
];

const RULE = /^\s*─{12,}\s*$/;
const EFFORT_WORD = "(none|minimal|low|medium|high|xhigh|extra high|max|ultra)";
const CODEX_STATUS = new RegExp(`^\\s*([A-Za-z][\\w.\\-]*)\\s+${EFFORT_WORD}\\s+·`, "i");
const CODEX_CHANGED = new RegExp(
  `Model changed to\\s+([\\w.\\-]+)\\s+${EFFORT_WORD}(?:\\s|$)`,
  "i",
);
const CLAUDE_BANNER = new RegExp(`([A-Z][\\w.\\- ]*?)\\s+with\\s+${EFFORT_WORD}\\s+effort`, "i");

function normalizeEffortWord(word: string): string {
  const lower = word.toLowerCase();
  return lower === "extra high" ? "xhigh" : lower;
}

function findLast<T>(
  lines: readonly string[],
  pick: (line: string) => T | undefined,
): T | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const found = pick(lines[index] ?? "");
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function claudeReady(lines: readonly string[]): boolean {
  const start = Math.max(0, lines.length - PROMPT_TAIL_LINES);
  for (let index = lines.length - 1; index >= start; index -= 1) {
    const line = lines[index] ?? "";
    if (!/^❯(\s|$)/.test(line) || /^❯\s*\d+\./.test(line)) {
      continue;
    }
    if (!RULE.test(lines[index - 1] ?? "")) {
      continue;
    }
    // 输入框可能换行成几行，下沿横线在后面几行里。
    for (let next = index + 1; next < Math.min(lines.length, index + 8); next += 1) {
      if (RULE.test(lines[next] ?? "")) {
        return true;
      }
    }
  }
  return false;
}

function codexReady(lines: readonly string[]): boolean {
  const start = Math.max(0, lines.length - PROMPT_TAIL_LINES);
  for (let index = lines.length - 1; index >= start; index -= 1) {
    const line = lines[index] ?? "";
    if (!/^›(\s|$)/.test(line) || /^›\s*\d+\./.test(line)) {
      continue;
    }
    for (let next = index + 1; next < Math.min(lines.length, index + 6); next += 1) {
      const footer = lines[next] ?? "";
      if (/\? for shortcuts/.test(footer) || CODEX_STATUS.test(footer)) {
        return true;
      }
    }
  }
  return false;
}

export function readPromptScreen(text: string, runtime: PromptRuntime): PromptScreen {
  const all = text.split("\n").map((line) => line.replace(/\s+$/, ""));
  const lines = all.slice(Math.max(0, all.length - TAIL_LINES));
  const bottom = lines.slice(Math.max(0, lines.length - PROMPT_TAIL_LINES));
  const busy = bottom.some((line) => BUSY_MARKERS.some((marker) => marker.test(line)));
  const ready = !busy && (runtime === "codex" ? codexReady(lines) : claudeReady(lines));
  let seen: { model: string; effort: string } | undefined;
  if (runtime === "codex") {
    // /model 之后状态行不一定重画（真机见过切完还显示旧强度），有「Model changed」就以它为准。
    const pick =
      (pattern: RegExp) =>
      (line: string): { model: string; effort: string } | undefined => {
        const match = pattern.exec(line);
        return match?.[1] !== undefined && match[2] !== undefined
          ? { model: match[1].toLowerCase(), effort: normalizeEffortWord(match[2]) }
          : undefined;
      };
    seen = findLast(all, pick(CODEX_CHANGED)) ?? findLast(lines, pick(CODEX_STATUS));
  } else {
    seen = findLast(all, (line) => {
      const match = CLAUDE_BANNER.exec(line);
      return match?.[1] !== undefined && match[2] !== undefined
        ? {
            model: match[1].replace(/^[^A-Za-z]+/, "").trim(),
            effort: normalizeEffortWord(match[2]),
          }
        : undefined;
    });
  }
  return {
    ready,
    busy,
    ...(seen !== undefined ? { model: seen.model, effort: seen.effort } : {}),
  };
}

/**
 * 输入框里是不是还留着这段文字（回车没提交）。看不到输入框返回 undefined。
 * 只比开头一小段：长文字会折行，粘贴后 Claude 也可能把它显示成「[Pasted text …]」。
 */
export function inputStillHolds(
  text: string,
  runtime: PromptRuntime,
  wanted: string,
): boolean | undefined {
  const lines = text.split("\n").map((line) => line.replace(/\s+$/, ""));
  const start = Math.max(0, lines.length - PROMPT_TAIL_LINES);
  const marker = runtime === "codex" ? /^›(\s|$)/ : /^❯(\s|$)/;
  for (let index = lines.length - 1; index >= start; index -= 1) {
    const line = lines[index] ?? "";
    if (!marker.test(line) || /^[❯›]\s*\d+\./.test(line)) {
      continue;
    }
    if (runtime === "claude-code" && !RULE.test(lines[index - 1] ?? "")) {
      continue;
    }
    const body = line.slice(1).trim();
    if (body === "") {
      return false;
    }
    const head = wanted.trim().slice(0, 12);
    return body.startsWith(head) || /^\[Pasted text/i.test(body);
  }
  return undefined;
}

/** 显示名（GPT-6.1-Sol）和模型名（gpt-6.1-sol）按同一个写法比较。 */
export function sameModelName(a: string, b: string): boolean {
  const norm = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, "-");
  return norm(a) === norm(b);
}

export interface PromptWatchTarget {
  readonly terminalId: string;
  readonly windowId: string;
  readonly runtime: PromptRuntime;
  readonly lastOutputAt: number;
}

export interface PromptWatchDeps {
  readonly targets: () => readonly PromptWatchTarget[];
  readonly phaseOf: (terminalId: string) => DeliverPhase;
  readonly render: (terminalId: string) => Promise<string | undefined>;
  readonly notePromptReady: (terminalId: string, options: { readonly settled: boolean }) => boolean;
  /** 因为看到提示符而判成了空闲。 */
  readonly onReady?: (windowId: string, terminalId: string) => void;
  readonly now: () => number;
  /** 状态未知时输出安静多久才看屏幕。 */
  readonly quietMs?: number;
  /** 忙着时输出安静多久才算被打断。CLI 干活时加载动画每秒都在刷新。 */
  readonly settledMs?: number;
}

export const PROMPT_WATCH_QUIET_MS = 800;
export const PROMPT_WATCH_SETTLED_MS = 8000;

export interface PromptWatch {
  tick(): Promise<void>;
  /** 读屏幕上的模型和强度。输出没变就用上次读到的。 */
  observe(terminalId: string, runtime: PromptRuntime): Promise<PromptScreen | undefined>;
  forget(terminalId: string): void;
}

export function createPromptWatch(deps: PromptWatchDeps): PromptWatch {
  const quietMs = deps.quietMs ?? PROMPT_WATCH_QUIET_MS;
  const settledMs = deps.settledMs ?? PROMPT_WATCH_SETTLED_MS;
  /** 每个终端上次看屏幕时的依据，依据没变不重看。 */
  const checked = new Map<string, string>();
  const observed = new Map<string, { readonly at: number; readonly screen: PromptScreen }>();
  let running = false;

  const read = async (
    terminalId: string,
    runtime: PromptRuntime,
    lastOutputAt: number,
  ): Promise<PromptScreen | undefined> => {
    const cached = observed.get(terminalId);
    if (cached !== undefined && cached.at === lastOutputAt) {
      return cached.screen;
    }
    const text = await deps.render(terminalId);
    if (text === undefined) {
      return undefined;
    }
    const screen = readPromptScreen(text, runtime);
    // 横幅滚走后读不到模型：沿用上次读到的。
    const merged =
      screen.model === undefined && cached?.screen.model !== undefined
        ? {
            ...screen,
            model: cached.screen.model,
            ...(cached.screen.effort !== undefined ? { effort: cached.screen.effort } : {}),
          }
        : screen;
    observed.set(terminalId, { at: lastOutputAt, screen: merged });
    return merged;
  };

  return {
    async tick() {
      if (running) {
        return;
      }
      running = true;
      try {
        const now = deps.now();
        const live = new Set<string>();
        for (const target of deps.targets()) {
          live.add(target.terminalId);
          const phase = deps.phaseOf(target.terminalId);
          if (phase !== "unknown" && phase !== "busy") {
            continue;
          }
          const quiet = now - target.lastOutputAt;
          const settled = quiet >= settledMs;
          if (quiet < quietMs || (phase === "busy" && !settled)) {
            continue;
          }
          const key = `${target.lastOutputAt}:${phase}:${settled ? 1 : 0}`;
          if (checked.get(target.terminalId) === key) {
            continue;
          }
          checked.set(target.terminalId, key);
          const screen = await read(target.terminalId, target.runtime, target.lastOutputAt);
          if (screen === undefined || !screen.ready) {
            continue;
          }
          if (deps.notePromptReady(target.terminalId, { settled })) {
            deps.onReady?.(target.windowId, target.terminalId);
          }
        }
        for (const id of [...checked.keys()]) {
          if (!live.has(id)) {
            checked.delete(id);
            observed.delete(id);
          }
        }
      } finally {
        running = false;
      }
    },
    async observe(terminalId, runtime) {
      const target = deps.targets().find((item) => item.terminalId === terminalId);
      if (target === undefined) {
        return undefined;
      }
      return read(terminalId, runtime, target.lastOutputAt);
    },
    forget(terminalId) {
      checked.delete(terminalId);
      observed.delete(terminalId);
    },
  };
}
