/**
 * 从事件流 / Run 证据里认出「跑的就是合同 verifyCmd」。
 *
 * completeTask 仍要求 Run.verifyResult.command 与合同完全一致（防拿别的命令充数）。
 * 本函数只负责认出包装后的原文；调用方把 VerifyResult.command 写成合同原文。
 *
 * Windows 上 Codex 给的是完整 powershell.exe 调用串（见 adapters events/types.ts），
 * 编排器若只做 trim 全等，活干完也会因缺 VerifyResult 被记失败。
 */

import { normalizeCommandKey } from "../permission/command.js";

function stripWrappingQuotes(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const start = trimmed[0];
  const end = trimmed[trimmed.length - 1];
  if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

const WRAPPER_FLAGS = [" -command ", " -c ", " /c ", " -lc "] as const;

/**
 * 剥一层常见 shell 包装（powershell / cmd / bash -c），认不出则缺席。
 * `git -c core.foo=1 status` 这类不是包装，前缀对不上 shell 名，不剥。
 */
function unwrapOnce(command: string): string | undefined {
  const lower = command.toLowerCase();
  let best = -1;
  let flagLen = 0;
  for (const flag of WRAPPER_FLAGS) {
    const idx = lower.lastIndexOf(flag);
    if (idx > best) {
      best = idx;
      flagLen = flag.length;
    }
  }
  if (best < 0) {
    return undefined;
  }
  const prefix = lower.slice(0, best);
  const isWrapper =
    /(?:powershell|pwsh|cmd|bash|zsh|dash)(?:\.exe)?/.test(prefix) ||
    /(?:^|[\s"/\\])sh(?:\.exe)?["']?(?:\s+-\S+)*$/.test(prefix.trim());
  if (!isWrapper) {
    return undefined;
  }
  return stripWrappingQuotes(command.slice(best + flagLen));
}

/** `cd 项目根 && git status` / `…; git status` 拆成可独立比对的段。不拆管道。 */
function splitSegments(command: string): string[] {
  return command
    .split(/\s*(?:&&|;)\s*/)
    .map((part) => stripWrappingQuotes(part.trim()))
    .filter((part) => part.length > 0);
}

/**
 * 实际跑到的命令是否算合同里的验证命令。
 * 认：空白折叠全等、剥一层 shell 包装后全等、`&&` / `;` 任一段全等。
 * 不认：子串（`echo git status` 不能充 `git status`）。
 */
export function matchesVerifyCommand(actual: string, expected: string): boolean {
  const want = normalizeCommandKey(expected);
  if (want.length === 0) {
    return false;
  }
  const seen = new Set<string>();
  const queue: string[] = [];
  const enqueue = (raw: string): void => {
    const normalized = normalizeCommandKey(raw);
    if (normalized.length === 0 || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    queue.push(normalized);
  };
  enqueue(actual);
  enqueue(stripWrappingQuotes(actual));
  for (const current of queue) {
    if (current === want) {
      return true;
    }
    const unwrapped = unwrapOnce(current);
    if (unwrapped !== undefined) {
      enqueue(unwrapped);
    }
    for (const segment of splitSegments(current)) {
      enqueue(segment);
    }
  }
  return false;
}
