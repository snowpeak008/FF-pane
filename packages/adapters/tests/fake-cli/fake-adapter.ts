/**
 * 参考适配器（仅测试用）：把 fake-agent.mjs 的迷你协议映射为统一 AgentEvent，
 * 完整走 W2.1a spawn → W2.1b 行解析 → W2.1c 接口约定，
 * 作为 W2.3~2.6 真实适配器的实现范式（含"end 兜底合成"与"stderr 必须消费"）。
 */

import { fileURLToPath } from "node:url";
import type { NativeSessionId, RuntimeId } from "@ff-pane/shared";
import type {
  AdapterCapabilities,
  AdapterTurn,
  AdapterTurnContext,
  AgentAdapter,
  AgentEvent,
  AgentProcessHandle,
} from "../../src/index.js";
import { readJsonlStream, spawnAgentProcess, toRawEvent } from "../../src/index.js";

const FAKE_CLI_PATH = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));
const FAKE_RUNTIME: RuntimeId = "fake-cli";

const FAKE_CAPABILITIES: AdapterCapabilities = {
  nativeResume: "no",
  streaming: "yes",
  fileChangeEvents: "partial",
  commandEvents: "yes",
  permissionForwarding: "no",
  gracefulCancel: "partial",
};

/** 消费即目的（W2.1a 约定：两条流都必须被消费，否则背压会卡住进程）。 */
async function drain(stream: AsyncIterable<Buffer>): Promise<void> {
  for await (const _chunk of stream) {
    // 丢弃：fake-cli 的 stderr 无诊断价值
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** 迷你协议 → 统一事件。返回 undefined 表示该行不产生事件。 */
function mapNative(cwd: string, native: Record<string, unknown>): AgentEvent | undefined {
  switch (native["type"]) {
    case "session": {
      const id = asString(native["session_id"]);
      return id === undefined
        ? toRawEvent(FAKE_RUNTIME, native, "session 行缺 session_id")
        : {
            kind: "session_start",
            native: { nativeSessionId: id as NativeSessionId, cwd },
          };
    }
    case "say":
      return {
        kind: "text",
        content: asString(native["text"]) ?? "",
        final: native["final"] === true,
        channel: "answer",
      };
    case "write_file": {
      const path = asString(native["path"]);
      const kind = native["kind"];
      if (path === undefined || (kind !== "add" && kind !== "update" && kind !== "delete")) {
        return toRawEvent(FAKE_RUNTIME, native, "write_file 行字段非法");
      }
      return { kind: "file_change", path, changeKind: kind, status: "completed" };
    }
    case "run_cmd": {
      const exitCode = asNumber(native["exit_code"]);
      return {
        kind: "command",
        command: asString(native["command"]) ?? "",
        status: exitCode === 0 ? "completed" : "failed",
        ...(exitCode !== undefined ? { exitCode } : {}),
      };
    }
    case "done":
      return {
        kind: "end",
        reason: "completed",
        usage: {
          ...(asNumber(native["input_tokens"]) !== undefined
            ? { inputTokens: asNumber(native["input_tokens"]) }
            : {}),
          ...(asNumber(native["output_tokens"]) !== undefined
            ? { outputTokens: asNumber(native["output_tokens"]) }
            : {}),
        },
      };
    default:
      return toRawEvent(FAKE_RUNTIME, native, "fake 协议未定义的事件类型");
  }
}

interface FakeTurnInternals {
  readonly turn: AdapterTurn;
  readonly handle: AgentProcessHandle;
}

function startFakeTurn(ctx: AdapterTurnContext, mode: string): FakeTurnInternals {
  const handle = spawnAgentProcess({
    command: process.execPath,
    args: [FAKE_CLI_PATH, `--mode=${mode}`],
    cwd: ctx.cwd,
    ...(ctx.env !== undefined ? { env: ctx.env } : {}),
    ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    stdin: "closed",
  });

  let cancelRequested = false;

  async function* events(): AsyncGenerator<AgentEvent> {
    const stderrDone = drain(handle.stderr);
    let sawEnd = false;
    for await (const record of readJsonlStream(handle.stdout)) {
      const event = record.ok
        ? mapNative(ctx.cwd, record.value)
        : toRawEvent(FAKE_RUNTIME, record.raw, record.reason);
      if (event === undefined) {
        continue;
      }
      if (event.kind === "end") {
        sawEnd = true;
      }
      yield event;
    }
    const exit = await handle.exitPromise;
    await stderrDone;
    if (!sawEnd) {
      // 四家共同兜底约定（events/types.ts EndEvent 注释）：
      // 流断而无终止事件 → 主动取消记 cancelled，否则 crashed。
      yield {
        kind: "end",
        reason: cancelRequested || exit.kind === "timeout" ? "cancelled" : "crashed",
        ...(exit.exitCode !== null ? { exitCode: exit.exitCode } : {}),
        ...(exit.error !== null ? { message: exit.error } : {}),
      };
    }
  }

  return {
    handle,
    turn: {
      events: events(),
      cancel: async (): Promise<void> => {
        cancelRequested = true;
        await handle.kill();
      },
    },
  };
}

/** 构造 fake 适配器；mode 控制 fake-cli 行为剧本。 */
export function createFakeAdapter(mode = "happy"): AgentAdapter {
  return {
    runtime: FAKE_RUNTIME,
    displayName: "Fake CLI（联调测试）",
    capabilities: (): AdapterCapabilities => FAKE_CAPABILITIES,
    startTurn: (ctx: AdapterTurnContext): AdapterTurn => startFakeTurn(ctx, mode).turn,
  };
}
