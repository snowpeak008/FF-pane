/**
 * MCP 注入单测（T6.6）：codex 的 `-c mcp_servers.*` 覆盖与 claude 的 `--mcp-config` 文件。
 *
 * 核心断言是**隔离性**：注入一律逐轮、进程级，不写用户的 ~/.codex/config.toml 与
 * ~/.claude.json；以及 TOML / JSON 两种编译产物的形状正确（形状错了 CLI 只会静默
 * 不加载该服务器——这类失败没有任何报错，只能靠单测钉住）。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpStdioServerSpec } from "../src/adapter.js";
import { buildClaudeCodeArgs } from "../src/claude-code/args.js";
import {
  buildClaudeMcpConfig,
  claudeMcpToolName,
  writeClaudeMcpFile,
} from "../src/claude-code/mcp-file.js";
import { buildCodexArgs, buildCodexMcpOverrides } from "../src/codex/command.js";

const SERVER: McpStdioServerSpec = {
  command: "C:\\Program Files\\FF-pane\\FF-pane.exe",
  args: ["--run-as-node", "out/main/knowledge-mcp.js"],
  env: { FF_PANE_KNOWLEDGE_DB: "C:\\Users\\me\\.aiworkbench\\index.sqlite" },
  allowedTools: ["knowledge_search"],
};

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("codex：per-launch -c 覆盖", () => {
  it("command / args / env 编译成合法 TOML 值", () => {
    const overrides = buildCodexMcpOverrides({ ffpane: SERVER });
    expect(overrides["mcp_servers.ffpane.command"]).toBe(
      '"C:\\\\Program Files\\\\FF-pane\\\\FF-pane.exe"',
    );
    expect(overrides["mcp_servers.ffpane.args"]).toBe(
      '["--run-as-node", "out/main/knowledge-mcp.js"]',
    );
    expect(overrides["mcp_servers.ffpane.env"]).toBe(
      '{ "FF_PANE_KNOWLEDGE_DB" = "C:\\\\Users\\\\me\\\\.aiworkbench\\\\index.sqlite" }',
    );
  });

  it("Windows 反斜杠被转义——裸反斜杠在 TOML 基本字符串里是转义符，不转义就是坏值", () => {
    const overrides = buildCodexMcpOverrides({
      x: { command: "C:\\a\\b.exe" },
    });
    expect(overrides["mcp_servers.x.command"]).toBe('"C:\\\\a\\\\b.exe"');
  });

  it("空 args / env 不产出对应键（少一个键胜过一个空值）", () => {
    const overrides = buildCodexMcpOverrides({ x: { command: "srv", args: [], env: {} } });
    expect(Object.keys(overrides)).toEqual(["mcp_servers.x.command"]);
  });

  it("不写 enabled 键：老版本 codex 不认识未知配置键会拒绝启动", () => {
    const overrides = buildCodexMcpOverrides({ ffpane: SERVER });
    expect(Object.keys(overrides).some((key) => key.endsWith(".enabled"))).toBe(false);
  });

  it("经 buildCodexArgs 落成 -c 参数对", () => {
    const args = buildCodexArgs({
      cwd: "/repo",
      configOverrides: buildCodexMcpOverrides({ ffpane: { command: "srv" } }),
    });
    const at = args.indexOf('mcp_servers.ffpane.command="srv"');
    expect(at).toBeGreaterThan(0);
    expect(args[at - 1]).toBe("-c");
  });

  it("不注入时不产生任何 mcp_servers 参数", () => {
    const args = buildCodexArgs({ cwd: "/repo" });
    expect(args.join(" ")).not.toContain("mcp_servers");
  });
});

describe("claude：逐轮 --mcp-config 文件", () => {
  it("编译成 { mcpServers: { <name>: { type:'stdio', command, args, env } } }", () => {
    const config = JSON.parse(buildClaudeMcpConfig({ ffpane: SERVER })) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(config.mcpServers["ffpane"]).toEqual({
      type: "stdio",
      command: SERVER.command,
      args: SERVER.args,
      env: SERVER.env,
    });
  });

  it("无 env 时不写 env 键", () => {
    const config = JSON.parse(buildClaudeMcpConfig({ x: { command: "srv" } })) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect("env" in (config.mcpServers["x"] ?? {})).toBe(false);
  });

  it("落盘到独立临时目录，remove 后文件与目录都不留", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "ff-pane-mcp-test-"));
    const file = writeClaudeMcpFile({ ffpane: SERVER }, { dir: tempRoot });
    expect(existsSync(file.path)).toBe(true);
    expect(JSON.parse(readFileSync(file.path, "utf8"))).toHaveProperty("mcpServers.ffpane");

    await file.remove();
    expect(existsSync(file.path)).toBe(false);
    // remove 幂等
    await expect(file.remove()).resolves.toBeUndefined();
  });

  it("逐轮一份独立文件：两次落盘互不覆盖", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "ff-pane-mcp-test-"));
    const a = writeClaudeMcpFile({ ffpane: SERVER }, { dir: tempRoot });
    const b = writeClaudeMcpFile({ ffpane: SERVER }, { dir: tempRoot });
    expect(a.path).not.toBe(b.path);
  });

  it("工具名带 mcp__<服务器>__ 前缀", () => {
    expect(claudeMcpToolName("ffpane", "knowledge_search")).toBe("mcp__ffpane__knowledge_search");
  });
});

describe("claude：参数装配", () => {
  it("注入时给出 --mcp-config，并把 MCP 工具并进 --allowedTools（不覆盖信封翻译结果）", () => {
    const args = buildClaudeCodeArgs(
      { allowedTools: ["Write", "Bash(git *)"] },
      {
        mcpConfigPath: "/tmp/x/ff-pane-mcp.json",
        mcpAllowedTools: ["mcp__ffpane__knowledge_search"],
        strictMcp: true,
      },
    );
    expect(args).toContain("--mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/tmp/x/ff-pane-mcp.json");

    const allowedAt = args.indexOf("--allowedTools");
    expect(args.slice(allowedAt + 1, allowedAt + 4)).toEqual([
      "Write",
      "Bash(git *)",
      "mcp__ffpane__knowledge_search",
    ]);
  });

  it("strictMcp 时传 --strict-mcp-config（MCP 工具绕过 §7 信封，默认排他）", () => {
    const args = buildClaudeCodeArgs({}, { mcpConfigPath: "/tmp/a.json", strictMcp: true });
    expect(args).toContain("--strict-mcp-config");
  });

  it("允许继承用户 MCP 时不传 --strict-mcp-config", () => {
    const args = buildClaudeCodeArgs({}, { mcpConfigPath: "/tmp/a.json" });
    expect(args).not.toContain("--strict-mcp-config");
  });

  it("未注入 MCP 时既不传 --mcp-config 也不传 --strict-mcp-config", () => {
    const args = buildClaudeCodeArgs({}, {});
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--strict-mcp-config");
  });

  it("构造级 strictMcpConfig 逃生门仍生效", () => {
    const args = buildClaudeCodeArgs({ strictMcpConfig: true }, {});
    expect(args).toContain("--strict-mcp-config");
  });
});
