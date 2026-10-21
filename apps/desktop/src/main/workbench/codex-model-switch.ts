/**
 * 在 Codex 窗口里用 /model 切换模型和思考强度（续接不了时的退路）。
 *
 * 真机核对（codex-cli 0.162.0，2026-10-21）：
 * - /model 不接参数，「/model gpt-x low」会被当成一条普通消息发出去，所以只打「/model」再回车。
 * - 第一屏「Select Model and Effort」列出模型，「› 」是当前高亮，「(current)」是正在用的；回车进第二屏。
 * - 第二屏「Select Reasoning Level for …」列出强度，底下是「enter default · s session · esc back」。
 *   回车会把选择写成 config.toml 的默认值，影响用户在别处用的 Codex；按 s 只改这个会话。这里只按 s。
 * - Max、Ultra 在「More reasoning…」里面，回车进去是「Advanced Reasoning」屏，同样按 s 只改本会话。
 * - 选完屏幕上打出「Model changed to gpt-6-astra xhigh for this session only」。
 * - 刚启动还没就绪时打字会出现「Waiting for startup」，要等它消失。
 * 每一步都先看屏幕再按键，看不到预期的画面就按 Esc 退出，不盲按。
 */

import { readPromptScreen, sameModelName } from "./prompt-ready";

export interface CodexSwitchDeps {
  readonly write: (data: string) => void;
  /** 渲染后的屏幕文字。 */
  readonly screen: () => Promise<string>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export type CodexSwitchResult =
  | { readonly ok: true; readonly model: string; readonly effort: string }
  | { readonly ok: false; readonly error: string };

const KEY_DOWN = "\u001b[B";
const KEY_UP = "\u001b[A";
const KEY_ESC = "\u001b";
const POLL_MS = 250;
const STARTUP_WAIT_MS = 30_000;
const STEP_WAIT_MS = 6000;

const EFFORT_LABEL: Readonly<Record<string, string>> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

export interface PickerOption {
  readonly index: number;
  readonly label: string;
  readonly current: boolean;
  readonly selected: boolean;
}

/** 读出选择器的选项。拿不到标题就返回 undefined。 */
export function parsePicker(
  text: string,
  title: RegExp,
): { readonly options: readonly PickerOption[] } | undefined {
  const lines = text.split("\n");
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (title.test(lines[index] ?? "")) {
      start = index;
      break;
    }
  }
  if (start < 0) {
    return undefined;
  }
  const options: PickerOption[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^(›|\s)\s*(\d+)\.\s+(.*)$/.exec(line);
    if (match === null) {
      if (options.length > 0) {
        break;
      }
      continue;
    }
    const body = match[3] ?? "";
    const head = body.split(/\s{2,}/)[0] ?? body;
    const current = /\(current\)/i.test(head);
    const label = head
      .replace(/\((current|default)\)/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    options.push({
      index: Number(match[2]),
      label,
      current,
      selected: match[1] === "›",
    });
  }
  return options.length > 0 ? { options } : undefined;
}

/** 屏幕上最近一次「Model changed to … for this session only」。 */
export function parseModelChanged(
  text: string,
): { readonly model: string; readonly effort: string } | undefined {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /Model changed to\s+([\w.-]+)\s+([\w-]+(?: high)?)\b/i.exec(lines[index] ?? "");
    if (match?.[1] !== undefined && match[2] !== undefined) {
      const effort = match[2].toLowerCase() === "extra high" ? "xhigh" : match[2].toLowerCase();
      return { model: match[1].toLowerCase(), effort };
    }
  }
  return undefined;
}

export async function switchCodexModelInWindow(
  deps: CodexSwitchDeps,
  target: { readonly model?: string; readonly effort?: string },
): Promise<CodexSwitchResult> {
  const waitFor = async <T>(
    pick: (text: string) => T | undefined,
    timeoutMs: number,
  ): Promise<T | undefined> => {
    const deadline = deps.now() + timeoutMs;
    for (;;) {
      const found = pick(await deps.screen());
      if (found !== undefined) {
        return found;
      }
      if (deps.now() >= deadline) {
        return undefined;
      }
      await deps.sleep(POLL_MS);
    }
  };
  let pickerOpen = false;
  const bail = async (error: string): Promise<CodexSwitchResult> => {
    if (pickerOpen) {
      for (let step = 0; step < 3; step += 1) {
        deps.write(KEY_ESC);
        await deps.sleep(300);
      }
    }
    return { ok: false, error };
  };
  /** 把高亮挪到 wantIndex，并确认挪到了。 */
  const moveTo = async (title: RegExp, wantIndex: number): Promise<boolean> => {
    const now = parsePicker(await deps.screen(), title);
    const selected = now?.options.find((option) => option.selected);
    if (selected === undefined) {
      return false;
    }
    const delta = wantIndex - selected.index;
    for (let step = 0; step < Math.abs(delta); step += 1) {
      deps.write(delta > 0 ? KEY_DOWN : KEY_UP);
      await deps.sleep(60);
    }
    const landed = await waitFor((text) => {
      const parsed = parsePicker(text, title);
      return parsed?.options.find((option) => option.selected)?.index === wantIndex
        ? true
        : undefined;
    }, STEP_WAIT_MS);
    return landed === true;
  };

  if (target.effort !== undefined && EFFORT_LABEL[target.effort] === undefined) {
    return { ok: false, error: `Codex 的 /model 里没有思考强度 ${target.effort}。` };
  }
  const first = readPromptScreen(await deps.screen(), "codex");
  if (!first.ready) {
    return { ok: false, error: "Codex 没有停在空闲的输入框上。" };
  }

  deps.write("/model");
  const popup = await waitFor((text) => {
    const tail = text.split("\n").slice(-12).join("\n");
    if (/waiting for startup/i.test(tail)) {
      return undefined;
    }
    return /\/model\s+choose what model/i.test(tail) ? true : undefined;
  }, STARTUP_WAIT_MS);
  if (popup === undefined) {
    // 只打了字没回车：删掉这几个字。
    deps.write("\b".repeat("/model".length));
    return { ok: false, error: "Codex 还没就绪，/model 命令没有出来。" };
  }
  deps.write("\r");
  pickerOpen = true;

  const modelTitle = /Select Model and Effort/i;
  const models = await waitFor((text) => parsePicker(text, modelTitle), STEP_WAIT_MS);
  if (models === undefined) {
    return bail("没看到 Codex 的模型选择器。");
  }
  const wantModel =
    target.model !== undefined
      ? models.options.find((option) => sameModelName(option.label, target.model ?? ""))
      : (models.options.find((option) => option.current) ??
        models.options.find((option) => option.selected));
  if (wantModel === undefined) {
    return bail(
      `Codex 的模型列表里没有 ${target.model ?? "当前模型"}（有：${models.options.map((option) => option.label).join("、")}）。`,
    );
  }
  if (!(await moveTo(modelTitle, wantModel.index))) {
    return bail("没能在模型选择器里选中目标模型。");
  }
  deps.write("\r");

  let effortTitle = /Select Reasoning Level/i;
  const advancedTitle = /Advanced Reasoning/i;
  let efforts = await waitFor((text) => parsePicker(text, effortTitle), STEP_WAIT_MS);
  if (efforts === undefined) {
    return bail("没看到 Codex 的思考强度选择器。");
  }
  const wantLabel = target.effort !== undefined ? EFFORT_LABEL[target.effort] : undefined;
  const findEffort = (options: readonly PickerOption[]): PickerOption | undefined =>
    wantLabel !== undefined
      ? options.find((option) => option.label.toLowerCase() === wantLabel.toLowerCase())
      : (options.find((option) => option.current) ?? options.find((option) => option.selected));
  let wantEffort = findEffort(efforts.options);
  if (wantEffort === undefined && wantLabel !== undefined) {
    const more = efforts.options.find((option) => /more reasoning/i.test(option.label));
    if (more !== undefined) {
      if (!(await moveTo(effortTitle, more.index))) {
        return bail("没能打开 More reasoning。");
      }
      deps.write("\r");
      const before = efforts;
      efforts = await waitFor((text) => {
        const parsed = parsePicker(text, advancedTitle);
        return parsed !== undefined && findEffort(parsed.options) !== undefined
          ? parsed
          : undefined;
      }, STEP_WAIT_MS);
      if (efforts === undefined) {
        return bail(
          `Codex 的思考强度里没有 ${wantLabel}（有：${before.options.map((option) => option.label).join("、")}）。`,
        );
      }
      wantEffort = findEffort(efforts.options);
      effortTitle = advancedTitle;
    }
  }
  if (wantEffort === undefined) {
    return bail(
      `Codex 的思考强度里没有 ${wantLabel ?? "当前强度"}（有：${efforts.options.map((option) => option.label).join("、")}）。`,
    );
  }
  if (!(await moveTo(effortTitle, wantEffort.index))) {
    return bail("没能在思考强度选择器里选中目标强度。");
  }
  // 只改这个会话，不写用户的 config.toml。
  deps.write("s");
  pickerOpen = false;
  const changed = await waitFor((text) => parseModelChanged(text), STEP_WAIT_MS);
  if (changed === undefined) {
    return { ok: false, error: "按下后没看到 Codex 报「Model changed」，不确定有没有切换成功。" };
  }
  if (target.model !== undefined && !sameModelName(changed.model, target.model)) {
    return { ok: false, error: `Codex 报切到了 ${changed.model}，不是 ${target.model}。` };
  }
  if (target.effort !== undefined && changed.effort !== target.effort) {
    return { ok: false, error: `Codex 报思考强度是 ${changed.effort}，不是 ${target.effort}。` };
  }
  return { ok: true, model: changed.model, effort: changed.effort };
}
