/**
 * W2.1c 联调测试：AgentAdapter 接口经 fake-cli 全链路验证
 * （W2.1a spawn → W2.1b 行解析 → 统一事件 → turn 收尾约定）+ 注册表行为。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeId } from "@ff-pane/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/index.js";
import { AdapterRegistryError, createAdapterRegistry, isKnownRuntime } from "../src/index.js";
import { createFakeAdapter } from "./fake-cli/fake-adapter.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ff-pane-adapter-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const event of events) {
    all.push(event);
  }
  return all;
}

describe("AgentAdapter turn 模型（fake-cli 全链路）", () => {
  it("happy path：事件序列完整、native 绑定含 cwd、恰好一条 end 收尾", async () => {
    const turn = createFakeAdapter().startTurn({ cwd: workDir, prompt: "做点什么" });
    const events = await collect(turn.events);

    const kinds = events.map((event) => event.kind);
    expect(kinds).toStrictEqual([
      "session_start",
      "text",
      "text",
      "file_change",
      "command",
      "raw",
      "end",
    ]);

    const [start] = events;
    if (start?.kind !== "session_start") {
      throw new Error("首事件应为 session_start");
    }
    expect(start.native).toStrictEqual({ nativeSessionId: "fake-session-001", cwd: workDir });

    const finals = events.filter((event) => event.kind === "text").map((event) => event.final);
    expect(finals).toStrictEqual([false, true]);

    const end = events.at(-1);
    if (end?.kind !== "end") {
      throw new Error("末事件应为 end");
    }
    expect(end.reason).toBe("completed");
    expect(end.usage).toStrictEqual({ inputTokens: 12, outputTokens: 5 });
  });

  it("非 JSON 行经 raw 通道上交且流不中断", async () => {
    const turn = createFakeAdapter("garbage").startTurn({ cwd: workDir, prompt: "" });
    const events = await collect(turn.events);

    const raws = events.filter((event) => event.kind === "raw");
    expect(raws.some((raw) => raw.native === "WARN: 这是一条裸文本诊断行，不是 JSON")).toBe(true);
    expect(events.at(-1)?.kind).toBe("end");
    expect(events.at(-1)).toMatchObject({ reason: "completed" });
  });

  it("cancel：hang 模式下取消后 end(reason=cancelled) 正常收尾且进程已终结", async () => {
    const adapter = createFakeAdapter("hang");
    const turn = adapter.startTurn({ cwd: workDir, prompt: "" });

    const received: AgentEvent[] = [];
    const consuming = (async () => {
      for await (const event of turn.events) {
        received.push(event);
        if (event.kind === "session_start") {
          await turn.cancel();
        }
      }
    })();
    await consuming;

    expect(received.at(0)?.kind).toBe("session_start");
    const end = received.at(-1);
    if (end?.kind !== "end") {
      throw new Error("取消后事件流必须以 end 收尾");
    }
    expect(end.reason).toBe("cancelled");
    // 幂等：重复取消无害
    await expect(turn.cancel()).resolves.toBeUndefined();
  });

  it("abrupt：进程带非零退出码消亡且无 done → 合成 end(reason=crashed, exitCode=1)", async () => {
    const turn = createFakeAdapter("abrupt").startTurn({ cwd: workDir, prompt: "" });
    const events = await collect(turn.events);

    const end = events.at(-1);
    if (end?.kind !== "end") {
      throw new Error("崩溃兜底必须合成 end");
    }
    expect(end.reason).toBe("crashed");
    expect(end.exitCode).toBe(1);
  });
});

describe("适配器注册表", () => {
  it("注册 / 取用 / 列举（按 runtime 字典序）", () => {
    const registry = createAdapterRegistry();
    const fake = createFakeAdapter();
    registry.register(fake);
    expect(registry.get("fake-cli" as RuntimeId)).toBe(fake);
    expect(registry.get("codex" as RuntimeId)).toBeUndefined();
    expect(registry.list().map((adapter) => adapter.runtime)).toStrictEqual(["fake-cli"]);
  });

  it("重复注册同一 runtime 抛 AdapterRegistryError", () => {
    const registry = createAdapterRegistry();
    registry.register(createFakeAdapter());
    expect(() => registry.register(createFakeAdapter())).toThrow(AdapterRegistryError);
  });

  it("isKnownRuntime 守卫与 M1 覆盖矩阵一致", () => {
    for (const runtime of ["codex", "claude-code", "gemini-cli", "opencode", "generic-exec"]) {
      expect(isKnownRuntime(runtime)).toBe(true);
    }
    expect(isKnownRuntime("fake-cli")).toBe(false);
  });
});
