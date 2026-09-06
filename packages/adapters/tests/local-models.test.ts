import { describe, expect, it } from "vitest";
import {
  CLI_LOGIN_RUNTIMES,
  type CompletedExecution,
  DEFAULT_LIST_MODELS_TIMEOUT_MS,
  type ExecutionOutcome,
  LIST_MODELS_MAX_STREAM_BYTES,
  LOCAL_MODEL_RUNTIMES,
  listLocalModels,
  type ProcessExecutor,
  supportsLocalModelListing,
} from "../src/index.js";

/** 记录调用参数的假执行器。 */
function fakeExecutor(outcome: ExecutionOutcome): {
  execute: ProcessExecutor;
  calls: { cmd: string; args: readonly string[]; timeoutMs: number }[];
} {
  const calls: { cmd: string; args: readonly string[]; timeoutMs: number }[] = [];
  const execute: ProcessExecutor = (cmd, args, timeoutMs) => {
    calls.push({ cmd, args, timeoutMs });
    return Promise.resolve(outcome);
  };
  return { execute, calls };
}

function completed(exitCode: number, stdout = "", stderr = ""): CompletedExecution {
  return { kind: "completed", exitCode, stdout, stderr };
}

describe("能力面（T9.2 调研结论钉住）", () => {
  it("支持枚举的恰为 codex / opencode / grok-build 三家", () => {
    expect([...LOCAL_MODEL_RUNTIMES]).toEqual(["codex", "opencode", "grok-build"]);
  });

  it("LOCAL_MODEL_RUNTIMES ⊆ CLI_LOGIN_RUNTIMES（枚举面不超出 cli_login 面）", () => {
    const loginSet = new Set<string>(CLI_LOGIN_RUNTIMES);
    for (const runtime of LOCAL_MODEL_RUNTIMES) {
      expect(loginSet.has(runtime), `${runtime} 不在 CLI_LOGIN_RUNTIMES`).toBe(true);
    }
  });

  it("claude-code / gemini-cli 如实声明不支持（调研：无枚举途径，试探会起真轮次）", () => {
    expect(supportsLocalModelListing("claude-code")).toBe(false);
    expect(supportsLocalModelListing("gemini-cli")).toBe(false);
    expect(supportsLocalModelListing("codex")).toBe(true);
    expect(supportsLocalModelListing("opencode")).toBe(true);
    expect(supportsLocalModelListing("grok-build")).toBe(true);
  });

  it("不支持的 Runtime 直接 unsupported，不 spawn 任何进程", async () => {
    const { execute, calls } = fakeExecutor(completed(0, "should never run"));
    const result = await listLocalModels("claude-code", { execute });
    expect(result).toMatchObject({ ok: false, error: "unsupported" });
    expect(calls).toHaveLength(0);
  });
});

describe("codex：codex debug models（JSON 目录）", () => {
  const catalog = JSON.stringify({
    models: [
      { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide" },
      { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
      { slug: "gpt-5.4-mini", display_name: "GPT-5.4-Mini", visibility: "list" },
      { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide" },
    ],
  });

  it("解析 slug/display_name，过滤 visibility=hide 的内部条目", async () => {
    const { execute, calls } = fakeExecutor(completed(0, catalog));
    const result = await listLocalModels("codex", { execute });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.models.map((m) => m.id)).toEqual(["gpt-5.5", "gpt-5.4-mini"]);
    expect(result.models[0]?.displayName).toBe("GPT-5.5");
    // codex 目录无默认模型标记（默认在 config.toml）
    expect(result.models.every((m) => !m.isDefault)).toBe(true);
    expect(calls[0]).toMatchObject({
      cmd: "codex",
      args: ["debug", "models"],
      timeoutMs: DEFAULT_LIST_MODELS_TIMEOUT_MS,
    });
  });

  it("stdout 非 JSON → parse_error", async () => {
    const { execute } = fakeExecutor(completed(0, "not json at all"));
    const result = await listLocalModels("codex", { execute });
    expect(result).toMatchObject({ ok: false, error: "parse_error" });
  });

  it("JSON 里没有 models 数组 → parse_error", async () => {
    const { execute } = fakeExecutor(completed(0, JSON.stringify({ other: [] })));
    const result = await listLocalModels("codex", { execute });
    expect(result).toMatchObject({ ok: false, error: "parse_error" });
  });

  it("非零退出码 → cli_error", async () => {
    const { execute } = fakeExecutor(completed(2, "", "boom"));
    const result = await listLocalModels("codex", { execute });
    expect(result).toMatchObject({ ok: false, error: "cli_error" });
  });

  it("读流上限放宽到 4 MB（codex 目录真机约 400 KB，64 KB 缺省会截断）", () => {
    expect(LIST_MODELS_MAX_STREAM_BYTES).toBeGreaterThanOrEqual(400 * 1024);
  });
});

describe("opencode：opencode models（provider/model 逐行）", () => {
  it("解析 provider/model 行，过滤 logo / 表头 / 空行（真机 0 凭证形态）", async () => {
    // 真机输出形态：ANSI 色码 + logo 块 + 模型行
    const stdout = [
      "\u001B[0m",
      "█▀▀ █▀▀ ▀▀▀",
      "",
      "opencode/big-pickle",
      "opencode/nemotron-3-ultra-free",
      "deepseek/deepseek-chat",
      "",
    ].join("\n");
    const { execute, calls } = fakeExecutor(completed(0, stdout));
    const result = await listLocalModels("opencode", { execute });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.models.map((m) => m.id)).toEqual([
      "opencode/big-pickle",
      "opencode/nemotron-3-ultra-free",
      "deepseek/deepseek-chat",
    ]);
    expect(calls[0]).toMatchObject({ cmd: "opencode", args: ["models"] });
  });

  it("没有任何 provider/model 行 → parse_error", async () => {
    const { execute } = fakeExecutor(completed(0, "some banner text\nno models here"));
    const result = await listLocalModels("opencode", { execute });
    expect(result).toMatchObject({ ok: false, error: "parse_error" });
  });
});

describe("grok-build：grok models（纯文本清单，未登录形态真机录得）", () => {
  const grokOutput = [
    "You are not authenticated.",
    "",
    "Default model: grok-4.6",
    "",
    "Available models:",
    "  * grok-4.6 (default)",
    "  - grok-4.5",
    "",
  ].join("\n");

  it("解析 * / - 前缀行，default 标记回填 isDefault（未登录清单照出）", async () => {
    const { execute, calls } = fakeExecutor(completed(0, grokOutput));
    const result = await listLocalModels("grok-build", { execute });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.models).toEqual([
      { id: "grok-4.6", displayName: "grok-4.6", isDefault: true },
      { id: "grok-4.5", displayName: "grok-4.5", isDefault: false },
    ]);
    expect(calls[0]).toMatchObject({ cmd: "grok", args: ["models"] });
  });

  it("无清单行 → parse_error", async () => {
    const { execute } = fakeExecutor(completed(0, "You are not authenticated.\n"));
    const result = await listLocalModels("grok-build", { execute });
    expect(result).toMatchObject({ ok: false, error: "parse_error" });
  });
});

describe("执行器三态透传", () => {
  it("cli_missing → cli_missing 分类", async () => {
    const { execute } = fakeExecutor({ kind: "cli_missing" });
    const result = await listLocalModels("codex", { execute });
    expect(result).toMatchObject({ ok: false, error: "cli_missing" });
  });

  it("timeout → timeout 分类", async () => {
    const { execute } = fakeExecutor({ kind: "timeout" });
    const result = await listLocalModels("opencode", { execute });
    expect(result).toMatchObject({ ok: false, error: "timeout" });
  });

  it("执行器抛异常 → cli_error（吞掉不上抛，枚举失败不挂界面）", async () => {
    const execute: ProcessExecutor = () => Promise.reject(new Error("spawn blew up"));
    const result = await listLocalModels("grok-build", { execute });
    expect(result).toMatchObject({ ok: false, error: "cli_error" });
    if (!result.ok) {
      expect(result.detail).toContain("spawn blew up");
    }
  });
});
