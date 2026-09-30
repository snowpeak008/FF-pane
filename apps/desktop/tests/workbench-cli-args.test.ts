/**
 * T10.4 交互式 CLI 参数组装快照单测。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertSecretAbsent,
  buildInteractiveClaudeArgs,
  buildInteractiveCodexArgs,
} from "../src/main/workbench/cli-args";
import { assertLaunchCliIpcSafe, WorkbenchCliLaunchError } from "../src/main/workbench/launch-cli";
import {
  WorkbenchMcpTempRegistry,
  writeWorkbenchClaudeMcpFile,
} from "../src/main/workbench/mcp-temp";

describe("buildInteractiveClaudeArgs", () => {
  it("新开：session-id + model + effort + mcp strict", () => {
    expect(
      buildInteractiveClaudeArgs({
        sessionId: "11111111-1111-4111-8111-111111111111",
        model: "sonnet",
        effort: "high",
        mcpConfigPath: "C:\\tmp\\mcp.json",
        initialPrompt: "hello",
      }),
    ).toMatchInlineSnapshot(`
      [
        "--session-id",
        "11111111-1111-4111-8111-111111111111",
        "--model",
        "sonnet",
        "--effort",
        "high",
        "--mcp-config",
        "C:\\tmp\\mcp.json",
        "--strict-mcp-config",
        "hello",
      ]
    `);
  });

  it("续接：resume + 重传 mcp", () => {
    expect(
      buildInteractiveClaudeArgs({
        resumeSessionId: "11111111-1111-4111-8111-111111111111",
        model: "sonnet",
        mcpConfigPath: "C:\\tmp\\mcp.json",
      }),
    ).toEqual([
      "--resume",
      "11111111-1111-4111-8111-111111111111",
      "--model",
      "sonnet",
      "--mcp-config",
      "C:\\tmp\\mcp.json",
      "--strict-mcp-config",
    ]);
  });

  it("local 无模型无 effort 时只带 session-id", () => {
    expect(
      buildInteractiveClaudeArgs({
        sessionId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual(["--session-id", "11111111-1111-4111-8111-111111111111"]);
  });

  it("read-only 权限：plan + disallowedTools；续接同样带上", () => {
    const fresh = buildInteractiveClaudeArgs({
      sessionId: "11111111-1111-4111-8111-111111111111",
      permission: "read-only",
    });
    expect(fresh).toContain("--permission-mode");
    expect(fresh).toContain("plan");
    expect(fresh).toContain("--disallowedTools");
    expect(fresh).toContain("Bash");
    const resumed = buildInteractiveClaudeArgs({
      resumeSessionId: "11111111-1111-4111-8111-111111111111",
      permission: "yolo",
    });
    expect(resumed).toContain("--dangerously-skip-permissions");
  });
});

describe("buildInteractiveCodexArgs", () => {
  it("新开：-C + model + overrides", () => {
    expect(
      buildInteractiveCodexArgs({
        cwd: "D:\\repo",
        model: "gpt-5",
        configOverrides: {
          model_reasoning_effort: JSON.stringify("medium"),
          "mcp_servers.ffpane.command": JSON.stringify("node"),
        },
        initialPrompt: "hi",
      }),
    ).toMatchInlineSnapshot(`
      [
        "-C",
        "D:\\repo",
        "-m",
        "gpt-5",
        "-c",
        "model_reasoning_effort="medium"",
        "-c",
        "mcp_servers.ffpane.command="node"",
        "hi",
      ]
    `);
  });

  it("续接精确 id", () => {
    expect(
      buildInteractiveCodexArgs({
        cwd: "D:\\repo",
        resume: true,
        resumeSessionId: "019fd7dc-9d5d-77e2-90aa-6ba82b6ff3f2",
      }),
    ).toEqual(["resume", "019fd7dc-9d5d-77e2-90aa-6ba82b6ff3f2", "-C", "D:\\repo"]);
  });

  it("续接无 id 打开选择器（不加 --last）", () => {
    expect(
      buildInteractiveCodexArgs({
        cwd: "D:\\repo",
        resume: true,
      }),
    ).toEqual(["resume", "-C", "D:\\repo"]);
  });

  it("权限：新开 -s/-a；续接改 -c sandbox_mode / approval_policy", () => {
    expect(
      buildInteractiveCodexArgs({
        cwd: "D:\\repo",
        permission: "edit",
      }),
    ).toEqual(["-C", "D:\\repo", "-s", "workspace-write", "-a", "on-request"]);
    expect(
      buildInteractiveCodexArgs({
        cwd: "D:\\repo",
        resume: true,
        resumeSessionId: "abc",
        permission: "edit-exec",
      }),
    ).toEqual([
      "resume",
      "abc",
      "-C",
      "D:\\repo",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="never"',
    ]);
  });
});

describe("assertLaunchCliIpcSafe prompt limit", () => {
  it("超长 initialPrompt 拒绝", async () => {
    const { MAX_INITIAL_PROMPT_CHARS } = await import("../src/main/workbench/launch-cli");
    expect(() =>
      assertLaunchCliIpcSafe({
        windowId: "w",
        initialPrompt: "x".repeat(MAX_INITIAL_PROMPT_CHARS + 1),
      }),
    ).toThrow(/initialPrompt exceeds/);
  });
});

describe("secret redline", () => {
  it("密钥不得出现在 args", () => {
    expect(() =>
      assertSecretAbsent("sk-secret-value", ["--model", "sonnet", "sk-secret-value"]),
    ).toThrow(/密钥/);
  });

  it("临时 MCP 文件不含密钥且可清理", async () => {
    const secret = "sk-should-not-leak";
    const file = writeWorkbenchClaudeMcpFile({
      ffpane: {
        command: "node",
        args: ["server.js"],
        env: { FF_PANE_TOKEN: "not-a-provider-key" },
      },
    });
    const text = readFileSync(file.path, "utf8");
    assertSecretAbsent(secret, [text, ...Object.values({ a: file.path })]);
    expect(text).not.toContain(secret);
    const registry = new WorkbenchMcpTempRegistry();
    registry.track("win-1", file);
    await registry.release("win-1");
    expect(() => readFileSync(file.path, "utf8")).toThrow();
  });
});

describe("assertLaunchCliIpcSafe", () => {
  it("拒绝 renderer 传入的 args/env/executable", () => {
    expect(() => assertLaunchCliIpcSafe({ windowId: "w", args: ["x"] })).toThrow(
      WorkbenchCliLaunchError,
    );
    expect(() => assertLaunchCliIpcSafe({ windowId: "w", env: { A: "1" } })).toThrow(
      /rejects field "env"/,
    );
    expect(() => assertLaunchCliIpcSafe({ windowId: "w", executable: "claude" })).toThrow(
      /executable/,
    );
    expect(() =>
      assertLaunchCliIpcSafe({
        windowId: "w",
        projectId: "p",
        projectRoot: "D:\\x",
        profileId: "prof",
        cols: 80,
        rows: 24,
      }),
    ).not.toThrow();
  });

  it("拒绝 renderer 伪造 parentWindowId / openedBy", () => {
    expect(() => assertLaunchCliIpcSafe({ windowId: "w", parentWindowId: "manager" })).toThrow(
      /parentWindowId/,
    );
    expect(() => assertLaunchCliIpcSafe({ windowId: "w", openedBy: "user" })).toThrow(/openedBy/);
  });
});

describe("MCP temp token redline", () => {
  it("临时 MCP 文件只含占位符，不含令牌明文", async () => {
    const { injectTokenIntoMcpServers, FF_PANE_WINDOW_TOKEN_ENV } = await import("@ff-pane/core");
    const token = "b".repeat(64);
    const servers = injectTokenIntoMcpServers(
      {
        ffpane: {
          command: "node",
          args: ["server.js"],
          env: { OTHER: "ok" },
        },
      },
      token,
      "claude-env-expand",
    );
    const file = writeWorkbenchClaudeMcpFile(servers);
    try {
      const text = readFileSync(file.path, "utf8");
      expect(text).toContain(`\${${FF_PANE_WINDOW_TOKEN_ENV}}`);
      expect(text).not.toContain(token);
      expect(file.directory).toMatch(/ff-pane-wb-mcp-[0-9a-f]{16}-/i);
    } finally {
      await file.remove();
    }
  });
});
