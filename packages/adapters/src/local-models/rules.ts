/**
 * 各 Runtime 的本地模型枚举命令与解析规则（T9.2 ③）。
 *
 * 全部为非交互的枚举命令，绝不触发登录流程或起真轮次。每条规则的依据是
 * T9.2 真机调研（2026-09-06，Windows 10 + PowerShell）：codex-cli 0.151.0、
 * OpenCode 1.18.25、grok 1.0.13（未登录形态）——结论落档各家
 * docs/adapters/*.md 的「本地模型枚举」节。
 */

import { stripAnsi } from "../auth-probe/sanitize.js";
import type { CompletedExecution } from "../auth-probe/types.js";
import type { LocalModelEntry, LocalModelRuntime, LocalModelsResult } from "./types.js";

/** 单个 Runtime 的枚举规则。 */
export interface LocalModelsRule {
  /** 枚举命令（可执行文件名，不含参数）。 */
  readonly command: string;
  /** 命令参数。 */
  readonly args: readonly string[];
  /** 对已完成的执行结果做解析，返回模型清单或分类失败。 */
  readonly parse: (execution: CompletedExecution) => LocalModelsResult;
}

function entry(id: string, displayName?: string, isDefault = false): LocalModelEntry {
  return { id, displayName: displayName ?? id, isDefault };
}

/**
 * codex：`codex debug models` → stdout 单个 JSON 对象 `{"models":[…]}`。
 *
 * 真机（0.151.0）：条目字段 slug（`-m` 可直接消费）/ display_name / visibility
 * （"list" 展示、"hide" 内部条目如 gpt-reserve、codex-auto-review）。退出码恒 0，
 * 未登录也出内置目录（空 CODEX_HOME 实测）。目录无「当前默认」标记（默认模型在
 * config.toml），isDefault 恒 false。整包约 300~400 KB（条目内嵌 instructions
 * 模板）——执行器读流上限由 probe.ts 放宽。
 */
const codexRule: LocalModelsRule = {
  command: "codex",
  args: ["debug", "models"],
  parse(execution) {
    if (execution.exitCode !== 0) {
      return {
        ok: false,
        error: "cli_error",
        detail: `codex debug models 退出码 ${execution.exitCode}（预期 0）`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(execution.stdout);
    } catch {
      return { ok: false, error: "parse_error", detail: "stdout 不是合法 JSON" };
    }
    const models =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)["models"]
        : undefined;
    if (!Array.isArray(models)) {
      return { ok: false, error: "parse_error", detail: "JSON 里没有 models 数组" };
    }
    const entries: LocalModelEntry[] = [];
    for (const item of models) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const fields = item as Record<string, unknown>;
      const slug = fields["slug"];
      if (typeof slug !== "string" || slug.length === 0) {
        continue;
      }
      // visibility === "hide" 是内部条目（自动审查模型等），选择器不该展示
      if (fields["visibility"] === "hide") {
        continue;
      }
      const displayName = fields["display_name"];
      entries.push(entry(slug, typeof displayName === "string" ? displayName : slug));
    }
    if (entries.length === 0) {
      return { ok: false, error: "parse_error", detail: "models 数组里没有可展示条目" };
    }
    return { ok: true, models: entries, detail: `codex 目录 ${entries.length} 个模型` };
  },
};

/**
 * opencode：`opencode models` → stdout 每行一个 `<providerID>/<modelID>`。
 *
 * 真机（1.18.25）：0 凭证形态出内置免费目录（opencode/* 7 条）；用户 auth login
 * 过的 Provider 会连同其模型进清单。退出码 0；输出可混 ANSI 码与空行（剥后按行取）。
 * `providerID/modelID` 正是适配器 parseOpenCodeModel 消费的 `-m` 格式，原样入清单。
 */
const opencodeRule: LocalModelsRule = {
  command: "opencode",
  args: ["models"],
  parse(execution) {
    if (execution.exitCode !== 0) {
      return {
        ok: false,
        error: "cli_error",
        detail: `opencode models 退出码 ${execution.exitCode}（预期 0）`,
      };
    }
    const lines = stripAnsi(`${execution.stdout}\n${execution.stderr}`)
      .split(/\r?\n/)
      .map((line) => line.trim())
      // 模型行形态：providerID/modelID（无空白）；表头 / logo / 空行都过滤掉
      .filter((line) => /^[A-Za-z0-9._-]+\/[^\s]+$/.test(line));
    if (lines.length === 0) {
      return { ok: false, error: "parse_error", detail: "输出里没有 provider/model 形态的行" };
    }
    return {
      ok: true,
      models: lines.map((line) => entry(line)),
      detail: `opencode 目录 ${lines.length} 个模型`,
    };
  },
};

/**
 * grok-build：`grok models` → 纯文本清单（无 JSON 选项，--json 实测 exit 2）。
 *
 * 真机（1.0.13，未登录）：exit 0，`Available models:` 之后逐行
 * `  * grok-4.6 (default)`（默认模型）/ `  - grok-4.5`（普通条目）；未登录首行
 * 是 "You are not authenticated." 但清单照出（内置目录）。登录形态清单是否更长
 * 未实测——解析按行前缀取，不假设条目数。
 */
const grokBuildRule: LocalModelsRule = {
  command: "grok",
  args: ["models"],
  parse(execution) {
    if (execution.exitCode !== 0) {
      return {
        ok: false,
        error: "cli_error",
        detail: `grok models 退出码 ${execution.exitCode}（预期 0）`,
      };
    }
    const lines = stripAnsi(`${execution.stdout}\n${execution.stderr}`).split(/\r?\n/);
    const entries: LocalModelEntry[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      const match = /^[*-]\s+(\S+)(\s+\(default\))?$/.exec(line);
      if (match?.[1] !== undefined) {
        entries.push(entry(match[1], match[1], match[2] !== undefined));
      }
    }
    if (entries.length === 0) {
      return { ok: false, error: "parse_error", detail: "输出里没有模型清单行（* / - 前缀）" };
    }
    return { ok: true, models: entries, detail: `grok 清单 ${entries.length} 个模型` };
  },
};

/** Runtime → 枚举规则映射。 */
export const LOCAL_MODEL_RULES: Readonly<Record<LocalModelRuntime, LocalModelsRule>> =
  Object.freeze({
    codex: codexRule,
    opencode: opencodeRule,
    "grok-build": grokBuildRule,
  });
