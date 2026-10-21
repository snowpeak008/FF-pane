/**
 * Codex 窗口里用 /model 切换：按真机画面做的假 Codex，核对每一步先看屏幕再按键，
 * 第二屏只按 s（本会话），绝不按回车写用户的 config.toml。
 */

import { describe, expect, it } from "vitest";
import {
  parseModelChanged,
  parsePicker,
  switchCodexModelInWindow,
} from "../src/main/workbench/codex-model-switch";
import {
  decideModelEffort,
  MODEL_EFFORT_DEFERRED_MESSAGE,
  modelEffortApplyMode,
} from "../src/main/workbench/model-effort";

const MODELS = ["GPT-6.1-Sol", "GPT-6-Astra", "GPT-6-Sol"];
const EFFORTS = ["Low", "Medium", "High", "Extra high", "More reasoning…"];
const MORE = ["Max", "Ultra"];
const SLUG: Readonly<Record<string, string>> = {
  Low: "low",
  Medium: "medium",
  High: "high",
  "Extra high": "xhigh",
  Max: "max",
  Ultra: "ultra",
};

function fakeCodex(options: { readonly startupPolls?: number } = {}) {
  let screen: "prompt" | "typed" | "models" | "efforts" | "more" | "done" = "prompt";
  let typed = "";
  let cursor = 0;
  let model = 0;
  let startupPolls = options.startupPolls ?? 0;
  let changed: string | undefined;
  const keys: string[] = [];
  const list = (title: string, items: readonly string[], current: number): string =>
    [
      `  ${title}`,
      ...items.map(
        (item, index) =>
          `${index === cursor ? "›" : " "} ${index + 1}. ${item}${index === current ? " (current)" : ""}  说明`,
      ),
      "  enter select · esc back",
    ].join("\n");
  return {
    keys,
    write(data: string) {
      keys.push(data);
      if (data === "\u001b") {
        screen = "prompt";
        typed = "";
        return;
      }
      if (screen === "prompt" || screen === "typed" || screen === "done") {
        if (data === "\r" && typed === "/model") {
          screen = "models";
          cursor = 0;
          typed = "";
          return;
        }
        if (data.startsWith("\b")) {
          typed = typed.slice(0, Math.max(0, typed.length - data.length));
          return;
        }
        typed += data;
        screen = "typed";
        return;
      }
      const items = screen === "models" ? MODELS : screen === "efforts" ? EFFORTS : MORE;
      if (data === "\u001b[B") {
        cursor = Math.min(items.length - 1, cursor + 1);
      } else if (data === "\u001b[A") {
        cursor = Math.max(0, cursor - 1);
      } else if (data === "\r" && screen === "models") {
        model = cursor;
        screen = "efforts";
        cursor = 1;
      } else if (data === "\r" && screen === "efforts" && EFFORTS[cursor] === "More reasoning…") {
        screen = "more";
        cursor = 0;
      } else if (data === "\r") {
        throw new Error("在强度屏按了回车：会写用户的 config.toml");
      } else if (data === "s") {
        const label = (screen === "efforts" ? EFFORTS : MORE)[cursor] ?? "";
        changed = `${(MODELS[model] ?? "").toLowerCase()} ${SLUG[label]}`;
        screen = "done";
      }
    },
    async screen(): Promise<string> {
      if (screen === "models") {
        return list("Select Model and Effort", MODELS, 0);
      }
      if (screen === "efforts") {
        return list(`Select Reasoning Level for ${MODELS[model]}`, EFFORTS, 0).replace(
          "enter select",
          "enter default · s session",
        );
      }
      if (screen === "more") {
        // 真机：子菜单标题是 Advanced Reasoning，标题下面还有一行提示。
        return list("Advanced Reasoning", MORE, -1)
          .replace("  Advanced Reasoning", "  Advanced Reasoning\n  ⚠ Consumes usage limits faster")
          .replace("enter select", "enter default · s session");
      }
      const lines: string[] = [];
      if (changed !== undefined) {
        lines.push(`• Model changed to ${changed} for this session only`);
      }
      if (screen === "typed") {
        if (startupPolls > 0) {
          startupPolls -= 1;
          return [`› ${typed}`, "  Waiting for startup  · esc cancel"].join("\n");
        }
        return [`› ${typed}  choose what model and reasoning effort to use`, `› ${typed}`].join(
          "\n",
        );
      }
      lines.push("› Ask Codex to do anything", "  GPT-6.1-Sol low · ~\\work", "  ? for shortcuts");
      return lines.join("\n");
    },
  };
}

function deps(codex: ReturnType<typeof fakeCodex>) {
  let now = 0;
  return {
    write: (data: string) => codex.write(data),
    screen: () => codex.screen(),
    sleep: async (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

describe("Codex /model 选择器", () => {
  it("读出选项、高亮和当前项", () => {
    const parsed = parsePicker(
      [
        "  Select Model and Effort",
        "  1. GPT-6.1-Sol (current)  Latest workhorse model",
        "› 2. GPT-6-Astra            Frontier intelligence",
        "  enter select · esc back",
      ].join("\n"),
      /Select Model and Effort/,
    );
    expect(parsed?.options).toEqual([
      { index: 1, label: "GPT-6.1-Sol", current: true, selected: false },
      { index: 2, label: "GPT-6-Astra", current: false, selected: true },
    ]);
    expect(parseModelChanged("• Model changed to gpt-6-astra xhigh for this session only")).toEqual(
      { model: "gpt-6-astra", effort: "xhigh" },
    );
  });

  it("换模型和强度：只按 s，读到 Model changed 才算成功", async () => {
    const codex = fakeCodex();
    const result = await switchCodexModelInWindow(deps(codex), {
      model: "gpt-6-astra",
      effort: "xhigh",
    });
    expect(result).toEqual({ ok: true, model: "gpt-6-astra", effort: "xhigh" });
    expect(codex.keys.at(-1)).toBe("s");
  });

  it("只改强度：模型留在当前那个", async () => {
    const codex = fakeCodex();
    const result = await switchCodexModelInWindow(deps(codex), { effort: "low" });
    expect(result).toEqual({ ok: true, model: "gpt-6.1-sol", effort: "low" });
  });

  it("Max 在 More reasoning 里面", async () => {
    const codex = fakeCodex();
    const result = await switchCodexModelInWindow(deps(codex), { effort: "max" });
    expect(result).toEqual({ ok: true, model: "gpt-6.1-sol", effort: "max" });
  });

  it("还没启动好：等 Waiting for startup 消失再回车", async () => {
    const codex = fakeCodex({ startupPolls: 3 });
    const result = await switchCodexModelInWindow(deps(codex), { effort: "high" });
    expect(result.ok).toBe(true);
  });

  it("列表里没有的模型：按 Esc 退出并报错", async () => {
    const codex = fakeCodex();
    const result = await switchCodexModelInWindow(deps(codex), { model: "gpt-9" });
    expect(result.ok).toBe(false);
    expect(codex.keys.filter((key) => key === "\u001b").length).toBeGreaterThan(0);
    expect(await codex.screen()).toContain("Ask Codex");
  });

  it("不在空闲输入框上不动手", async () => {
    const codex = fakeCodex();
    codex.write("hello");
    const result = await switchCodexModelInWindow(deps(codex), { effort: "low" });
    expect(result.ok).toBe(false);
    expect(codex.keys).toEqual(["hello"]);
  });
});

describe("改模型怎么生效", () => {
  const base = { running: true, phase: "idle" as const, needsConfirm: false };

  it("没聊过天：冷重启，状态未知也行", () => {
    const facts = { ...base, phase: "unknown" as const, canResume: false, hadConversation: false };
    expect(modelEffortApplyMode(facts)).toBe("cold");
    expect(decideModelEffort(facts).launch).toBe(true);
  });

  it("聊过、有编号：续接；正忙就排队", () => {
    const facts = { ...base, canResume: true, hadConversation: true };
    expect(modelEffortApplyMode(facts)).toBe("resume");
    expect(decideModelEffort(facts).launch).toBe(true);
    expect(decideModelEffort({ ...facts, phase: "busy" }).outcome).toBe("queued");
    expect(decideModelEffort({ ...facts, phase: "unknown" }).outcome).toBe("queued");
  });

  it("Codex 聊过没编号：在窗口里切换，不用确认", () => {
    const facts = {
      ...base,
      canResume: false,
      hadConversation: true,
      canSwitchInWindow: true,
      needsConfirm: true,
    };
    expect(modelEffortApplyMode(facts)).toBe("in-window");
    expect(decideModelEffort(facts).launch).toBe(true);
  });

  it("都不行：仅记录", () => {
    const decision = decideModelEffort({ ...base, canResume: false, hadConversation: true });
    expect(decision).toMatchObject({ outcome: "deferred", reason: "no-session" });
    expect(decision.message).toBe(MODEL_EFFORT_DEFERRED_MESSAGE);
  });
});
