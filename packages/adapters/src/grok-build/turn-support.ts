/**
 * Grok Build 两种传输模式（headless streaming-json / ACP agent stdio）共用的
 * 轮次辅助件（T8.5b 抽出）。纯函数与小工具，无状态。
 */

/// <reference types="node" />

import path from "node:path";
import process from "node:process";
import type { AgentEvent } from "../events/index.js";
import type { AgentProcessHandle, AgentProcessSpec } from "../process/index.js";
import { findExecutableOnWindowsPath } from "../process/index.js";
import type { GrokBuildTurn } from "./adapter.js";

/** 兜底 end 事件里携带的 stderr 尾巴上限。 */
export const STDERR_TAIL_LIMIT = 2 * 1024;

/** 子进程启动函数（测试注入假 CLI 用，款式同 claude-code 适配器）。 */
export type SpawnAgentProcessFn = (spec: AgentProcessSpec) => AgentProcessHandle;

/**
 * Windows 下先把命令名解析成绝对路径再交给 spawn 层。
 * 与 codex 适配器同因：W2.1a 的 PATH 解析读的是展开后普通对象上的 `PATH` 键，
 * 而 Windows 上实际键名是 `Path`，`grok` 会被误判成 ENOENT。
 */
export function resolveGrokCommand(command: string): string {
  if (process.platform !== "win32") {
    return command;
  }
  return findExecutableOnWindowsPath(command, process.env) ?? command;
}

/** Windows 路径大小写不敏感，故按平台规则比较 resume 绑定的 cwd 与本轮 cwd。 */
export function sameDirectory(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** 竞速一组 promise 与超时；无论谁先到都清掉定时器（不吊住事件循环）。 */
export async function raceWithTimeout(
  waits: readonly Promise<unknown>[],
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([...waits, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** 消费 stderr 并留最后一段（grok 的日志与更新提示走 stderr）。 */
export async function readStderrTail(stream: AsyncIterable<Buffer>): Promise<string> {
  let tail = "";
  for await (const chunk of stream) {
    tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL_LIMIT);
  }
  return tail.trim();
}

/**
 * 启动前校验失败时的轮次：不 spawn，事件流只有一条 end(failed)。
 * 依据 adapter.ts 的接口约定——startTurn 同步返回句柄，失败经事件流表达。
 */
export function failFastTurn(commandLine: readonly string[], message: string): GrokBuildTurn {
  async function* events(): AsyncGenerator<AgentEvent> {
    yield { kind: "end", reason: "failed", message };
  }
  return {
    events: events(),
    commandLine,
    cancel: async (): Promise<void> => {
      // 进程从未启动，取消无事可做（幂等）。
    },
  };
}

/** resume 绑定的启动前校验；返回拒绝原因（合法则 undefined）。两模式共用同一措辞。 */
export function resumeViolationOf(
  resume: { readonly nativeSessionId: string; readonly cwd: string },
  cwd: string,
): string | undefined {
  if (resume.nativeSessionId === "") {
    return "resume 绑定缺少 session_id，无法恢复 Grok 会话";
  }
  if (!sameDirectory(resume.cwd, cwd)) {
    return (
      `Grok 会话绑定的 cwd（${resume.cwd}）与本轮 cwd（${cwd}）不一致：` +
      "grok 的会话按 cwd 分桶存储，跨目录恢复会找不到会话或在错误目录里施工"
    );
  }
  return undefined;
}
