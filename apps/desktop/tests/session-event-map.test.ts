/**
 * T4.2 适配器事件 → 会话事件映射单测：增量类事件折算、权限载荷摘要、
 * session_start/end/raw 返回 null（由编排器处理）。纯逻辑。
 */

import type { AgentEvent } from "@ff-pane/adapters";
import { describe, expect, it } from "vitest";
import { describePermissionPayload, mapAgentEvent } from "../src/main/session/event-map";

describe("mapAgentEvent", () => {
  it("text（answer）", () => {
    const e: AgentEvent = { kind: "text", content: "hi", final: false, channel: "answer" };
    expect(mapAgentEvent("t1", e)).toEqual({
      turnId: "t1",
      kind: "text",
      channel: "answer",
      delta: "hi",
      final: false,
    });
  });

  it("file_change", () => {
    const e: AgentEvent = {
      kind: "file_change",
      path: "src/a.ts",
      changeKind: "add",
      status: "completed",
    };
    expect(mapAgentEvent("t1", e)).toEqual({
      turnId: "t1",
      kind: "file-change",
      path: "src/a.ts",
      changeKind: "add",
      status: "completed",
    });
  });

  it("command 带退出码", () => {
    const e: AgentEvent = { kind: "command", command: "ls", status: "completed", exitCode: 0 };
    expect(mapAgentEvent("t1", e)).toEqual({
      turnId: "t1",
      kind: "command",
      command: "ls",
      status: "completed",
      exitCode: 0,
    });
  });

  it("permission_request → 摘要 + 请求 ID", () => {
    const e: AgentEvent = {
      kind: "permission_request",
      nativeRequestId: "r1",
      payload: { kind: "write_path", path: "x" },
    };
    expect(mapAgentEvent("t1", e)).toEqual({
      turnId: "t1",
      kind: "permission-request",
      requestId: "r1",
      summary: "写入文件：x",
    });
  });

  it("session_start / end / raw → null", () => {
    expect(mapAgentEvent("t1", { kind: "session_start" } as AgentEvent)).toBeNull();
    expect(mapAgentEvent("t1", { kind: "end", reason: "completed" } as AgentEvent)).toBeNull();
    expect(
      mapAgentEvent("t1", { kind: "raw", runtime: "codex", native: {} } as AgentEvent),
    ).toBeNull();
  });
});

describe("describePermissionPayload", () => {
  it("覆盖各权限项", () => {
    expect(describePermissionPayload({ kind: "read_path", path: "a" })).toContain("a");
    expect(describePermissionPayload({ kind: "write_path", path: "b" })).toContain("b");
    expect(describePermissionPayload({ kind: "shell_command", command: "rm -rf" })).toContain(
      "rm -rf",
    );
    expect(describePermissionPayload({ kind: "network" })).toBeTruthy();
    expect(
      describePermissionPayload({
        kind: "dangerous_operation",
        operation: "git_push",
        detail: "推送到远端",
      }),
    ).toContain("git_push");
  });
});
