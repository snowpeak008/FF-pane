/**
 * T10.16：项目 .grok/config.toml 合并、不写用户目录、令牌不落盘。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { FF_PANE_WINDOW_TOKEN_ENV_PLACEHOLDER } from "@ff-pane/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNotUserGrokPath,
  grokProjectConfigPath,
  mergeGrokProjectConfig,
  writeGrokProjectMcpConfig,
} from "../src/main/workbench/grok-mcp-config";
import { isConfigToolCallerDenied } from "../src/mcp/config-tool";

const token = "a".repeat(64);
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ffpane-grok-cfg-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("mergeGrokProjectConfig", () => {
  it("保留用户自己的段落，只替换受管服务器，文件里没有令牌明文", () => {
    const existing = [
      "# keep me",
      "[permission]",
      'allow = ["Bash(git *)"]',
      "",
      "[mcp_servers.my-tool]",
      'command = "my-tool"',
      "",
      "[mcp_servers.ffpane-workbench]",
      'command = "old"',
      `env = { FF_PANE_WINDOW_TOKEN = ${JSON.stringify(token)} }`,
      "",
    ].join("\n");
    const merged = mergeGrokProjectConfig(
      existing,
      {
        "ffpane-workbench": {
          command: "grok-host",
          args: ["workbench-mcp.js"],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            FF_PANE_WINDOW_TOKEN: FF_PANE_WINDOW_TOKEN_ENV_PLACEHOLDER,
          },
        },
      },
      ["ffpane-workbench", "ffpane-knowledge", "ffpane-config"],
    );
    expect(merged).toContain("# keep me");
    expect(merged).toContain("[permission]");
    expect(merged).toContain("[mcp_servers.my-tool]");
    expect(merged).toContain('command = "grok-host"');
    expect(merged).not.toContain('command = "old"');
    expect(merged).toContain(FF_PANE_WINDOW_TOKEN_ENV_PLACEHOLDER);
    expect(merged).not.toContain(token);
    expect(merged.includes("\r")).toBe(false);
  });

  it("知识库和自配置开关关掉时删掉对应服务器，打开时写占位符", () => {
    const withBoth = mergeGrokProjectConfig(
      "",
      {
        "ffpane-workbench": {
          command: "host",
          env: { FF_PANE_WINDOW_TOKEN: `${"$"}{FF_PANE_WINDOW_TOKEN}` },
        },
        "ffpane-knowledge": { command: "host", args: ["knowledge-mcp.js"] },
        "ffpane-config": {
          command: "host",
          env: { FF_PANE_CONFIG_CALLER_ROLE: `${"$"}{FF_PANE_CONFIG_CALLER_ROLE}` },
        },
      },
      ["ffpane-workbench", "ffpane-knowledge", "ffpane-config"],
    );
    expect(withBoth).toContain("[mcp_servers.ffpane-knowledge]");
    expect(withBoth).toContain("[mcp_servers.ffpane-config]");
    const switchedOff = mergeGrokProjectConfig(
      withBoth,
      {
        "ffpane-workbench": { command: "host" },
      },
      ["ffpane-workbench", "ffpane-knowledge", "ffpane-config"],
    );
    expect(switchedOff).toContain("[mcp_servers.ffpane-workbench]");
    expect(switchedOff).not.toContain("ffpane-knowledge");
    expect(switchedOff).not.toContain("ffpane-config");
  });
});

describe("writeGrokProjectMcpConfig", () => {
  it("不写用户 ~/.grok", async () => {
    const target = grokProjectConfigPath(join(homedir(), ".grok"));
    expect(() => assertNotUserGrokPath(target)).toThrow(/user ~\/\.grok/);
    await expect(
      writeGrokProjectMcpConfig({
        projectRoot: join(homedir(), ".grok"),
        servers: { "ffpane-workbench": { command: "nope" } },
        managedNames: ["ffpane-workbench"],
      }),
    ).rejects.toThrow(/user ~\/\.grok/);
    expect(existsSync(join(homedir(), ".grok", ".grok", "config.toml"))).toBe(false);
  });

  it("写到项目目录，令牌明文不在文件里", async () => {
    const root = tempDir();
    const file = await writeGrokProjectMcpConfig({
      projectRoot: root,
      servers: {
        "ffpane-workbench": {
          command: "host",
          env: { FF_PANE_WINDOW_TOKEN: FF_PANE_WINDOW_TOKEN_ENV_PLACEHOLDER },
        },
      },
      managedNames: ["ffpane-workbench"],
    });
    const body = readFileSync(file, "utf8");
    expect(file).toBe(join(root, ".grok", "config.toml"));
    expect(body).toContain(FF_PANE_WINDOW_TOKEN_ENV_PLACEHOLDER);
    expect(body).not.toContain(token);
  });
});

describe("自配置调用者", () => {
  it("非管理者不能用，管理者可以", () => {
    expect(isConfigToolCallerDenied("worker")).toBe(true);
    expect(isConfigToolCallerDenied("planner")).toBe(true);
    expect(isConfigToolCallerDenied(`${"$"}{FF_PANE_CONFIG_CALLER_ROLE}`)).toBe(true);
    expect(isConfigToolCallerDenied("manager")).toBe(false);
    expect(isConfigToolCallerDenied(undefined)).toBe(false);
  });
});
