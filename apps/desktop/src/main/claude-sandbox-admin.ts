/**
 * 设置 → 工作台 →「Claude 沙盒」（T11.20 §3.4）：看 Claude 版本够不够、沙盒装没装；装、卸。
 * 全部走用户自己那份 Claude 的 `claude sandbox status / install / uninstall`，版本自然对得上
 * （用 npx 装最新的 sandbox-runtime，旧版 Claude 认不了，见计划 §5.1）。
 * 这几条命令同样要内部开关 CLAUDE_CODE_NANKEEN_KESTREL 才认 Windows 沙盒。
 */

import { execFile } from "node:child_process";
import process from "node:process";
import { resolveDirectCliTarget } from "@ff-pane/adapters";
import type { ClaudeSandboxCommandResult, ClaudeSandboxStatusView } from "../shared-ipc/contracts";
import type { InvokeHandlers } from "../shared-ipc/server";
import {
  CLAUDE_SANDBOX_GATE_ENV,
  CLAUDE_SANDBOX_MIN_VERSION,
  compareVersions,
} from "./workbench/claude-sandbox";
import {
  probeClaudeSandboxInstalled,
  probeClaudeVersion,
  resetClaudeSandboxProbeCache,
} from "./workbench/claude-sandbox-probe";

const STATUS_TIMEOUT_MS = 30_000;
/** 装、卸要等用户点 UAC，给足时间。 */
const ADMIN_TIMEOUT_MS = 10 * 60_000;

/** 输出里最后一行 JSON 对象。认不出返回 undefined。 */
export function lastJsonLine(output: string): Record<string, unknown> | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index] ?? "";
    if (!line.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 不是完整 JSON，接着往上找
    }
  }
  return undefined;
}

/** `claude sandbox install / uninstall --json` 的结果：status 为 ok 才算成。 */
export function parseSandboxCommandResult(
  output: string,
  exitOk: boolean,
): ClaudeSandboxCommandResult {
  const json = lastJsonLine(output);
  if (json === undefined) {
    return {
      ok: false,
      message: output.trim().slice(-2000) || (exitOk ? "" : "命令失败，没有输出。"),
    };
  }
  const status = typeof json["status"] === "string" ? json["status"] : "";
  const message = typeof json["message"] === "string" ? json["message"] : "";
  const left = Array.isArray(json["leftBehind"])
    ? json["leftBehind"].filter((item): item is string => typeof item === "string")
    : [];
  return {
    ok: status === "ok",
    message: [message, ...left.map((item) => `· ${item}`)].filter((line) => line !== "").join("\n"),
  };
}

function run(
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ readonly exitOk: boolean; readonly output: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        timeout: timeoutMs,
        windowsHide: true,
        encoding: "utf8",
        env: { ...process.env, [CLAUDE_SANDBOX_GATE_ENV]: "1" },
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({ exitOk: error === null, output: `${stdout ?? ""}\n${stderr ?? ""}` });
      },
    );
  });
}

function claudeTarget(args: readonly string[]): { file: string; args: string[] } | undefined {
  const target = resolveDirectCliTarget("claude", [...args], process.env);
  return target === undefined ? undefined : { file: target.file, args: [...target.args] };
}

export async function readClaudeSandboxStatus(): Promise<ClaudeSandboxStatusView> {
  const base = { minVersion: CLAUDE_SANDBOX_MIN_VERSION };
  if (process.platform !== "win32") {
    return {
      ...base,
      platformSupported: false,
      claudeFound: true,
      versionOk: true,
      installed: false,
      reasons: [],
    };
  }
  const probe = claudeTarget([]);
  if (probe === undefined) {
    return {
      ...base,
      platformSupported: true,
      claudeFound: false,
      versionOk: false,
      installed: false,
      reasons: [],
    };
  }
  const version = await probeClaudeVersion(probe);
  const versionOk =
    version === undefined || compareVersions(version, CLAUDE_SANDBOX_MIN_VERSION) >= 0;
  if (!versionOk) {
    // 旧版 Claude 认不了 status 的新格式，只看账户在不在
    return {
      ...base,
      platformSupported: true,
      claudeFound: true,
      ...(version !== undefined ? { claudeVersion: version } : {}),
      versionOk,
      installed: await probeClaudeSandboxInstalled(),
      reasons: [],
    };
  }
  const status = claudeTarget(["sandbox", "status"]);
  const result =
    status === undefined ? undefined : await run(status.file, status.args, STATUS_TIMEOUT_MS);
  const json = result === undefined ? undefined : lastJsonLine(result.output);
  const rawReasons: unknown = json?.["reasons"];
  const reasons = Array.isArray(rawReasons)
    ? rawReasons.filter((item): item is string => typeof item === "string")
    : [];
  return {
    ...base,
    platformSupported: true,
    claudeFound: true,
    ...(version !== undefined ? { claudeVersion: version } : {}),
    versionOk,
    installed: json?.["installed"] === true,
    reasons,
  };
}

async function adminCommand(args: readonly string[]): Promise<ClaudeSandboxCommandResult> {
  if (process.platform !== "win32") {
    return { ok: false, message: "只有 Windows 要装 Claude 沙盒。" };
  }
  const target = claudeTarget(args);
  if (target === undefined) {
    return { ok: false, message: "没找到 Claude Code（claude）。" };
  }
  const result = await run(target.file, target.args, ADMIN_TIMEOUT_MS);
  // 装上、卸掉都会改变开窗前的检查结果
  resetClaudeSandboxProbeCache();
  return parseSandboxCommandResult(result.output, result.exitOk);
}

type ClaudeSandboxChannel =
  | "claude-sandbox:status"
  | "claude-sandbox:install"
  | "claude-sandbox:uninstall";

export function createClaudeSandboxHandlers(): Pick<InvokeHandlers, ClaudeSandboxChannel> {
  return {
    "claude-sandbox:status": () => readClaudeSandboxStatus(),
    "claude-sandbox:install": () => adminCommand(["sandbox", "install"]),
    "claude-sandbox:uninstall": () => adminCommand(["sandbox", "uninstall", "--json"]),
  };
}
