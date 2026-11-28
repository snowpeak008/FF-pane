/**
 * T11.23：Gemini 窗口（agy 本机登录）。
 *
 * 重点是 hooks.json 的结构：2026-11-28 实测 agy 只在
 * `SessionStart` / `PreInvocation` / `PostInvocation` / `Stop` 接受平铺处理器，
 * `PreToolUse` 才用 matcher + hooks 分组。套错时 agy 只在 cli.log 里报解析失败，
 * 整份钩子都不生效，所以这里逐条钉住写出来的形状。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agyProcessEnv,
  agyProxyEnv,
  parseAgyModels,
  parseInternetSettings,
  proxyEnvFromSystem,
} from "../src/main/workbench/agy-cli";
import {
  agyHookCommand,
  agyHooksPath,
  agyMcpConfigPath,
  assertNotUserAgyPath,
  mergeAgyHooksDocument,
  mergeAgyMcpDocument,
  writeAgyProjectHooks,
} from "../src/main/workbench/agy-hook-config";
import { buildInteractiveAgyArgs } from "../src/main/workbench/cli-args";
import {
  agyPreToolUseOutput,
  agyStopEvent,
  extractAgyConversationId,
} from "../src/mcp/workbench-hook";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ffpane-agy-"));
  dirs.push(dir);
  return dir;
}

// 真实形态：`"<node>" "<…workbench-hook.mjs>" Agy…`。合并时按这段命令认自己的旧条目。
const COMMANDS = {
  AgySessionStart: '"C:/node.exe" "D:/app/workbench-hook.mjs" AgySessionStart',
  AgyPromptSubmit: '"C:/node.exe" "D:/app/workbench-hook.mjs" AgyPromptSubmit',
  AgyPostInvocation: '"C:/node.exe" "D:/app/workbench-hook.mjs" AgyPostInvocation',
  AgyPreToolUse: '"C:/node.exe" "D:/app/workbench-hook.mjs" AgyPreToolUse',
  AgyStop: '"C:/node.exe" "D:/app/workbench-hook.mjs" AgyStop',
} as const;

describe("agyHookCommand", () => {
  it("路径带空格时加引号", () => {
    expect(agyHookCommand("C:\\Program Files\\nodejs\\node.exe", "D:\\a b\\h.mjs", "AgyStop")).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "D:\\a b\\h.mjs" AgyStop',
    );
  });

  it("路径里有 cmd 会吃的字符就不装", () => {
    expect(agyHookCommand("C:\\node.exe", "D:\\a&b\\h.mjs", "AgyStop")).toBeUndefined();
    expect(agyHookCommand("", "D:\\h.mjs", "AgyStop")).toBeUndefined();
  });
});

describe("mergeAgyHooksDocument", () => {
  it("四个事件平铺、PreToolUse 分组", () => {
    const text = mergeAgyHooksDocument(undefined, COMMANDS);
    expect(text).toBeDefined();
    const hook = (JSON.parse(text ?? "{}") as Record<string, unknown>)[
      "ffpane-workbench"
    ] as Record<string, unknown>;
    for (const event of ["SessionStart", "PreInvocation", "PostInvocation", "Stop"]) {
      const entries = hook[event] as Record<string, unknown>[];
      expect(entries).toHaveLength(1);
      // 平铺：直接是处理器，不能再套 matcher / hooks
      expect(entries[0]?.["command"]).toBeTypeOf("string");
      expect(entries[0]?.["matcher"]).toBeUndefined();
      expect(entries[0]?.["hooks"]).toBeUndefined();
      expect(entries[0]?.["type"]).toBe("command");
    }
    const preTool = hook["PreToolUse"] as Record<string, unknown>[];
    expect(preTool).toHaveLength(1);
    expect(preTool[0]?.["matcher"]).toBe("");
    expect(((preTool[0]?.["hooks"] ?? []) as unknown[]).length).toBe(1);
    // PostToolUse 只认空对象，不装
    expect(hook["PostToolUse"]).toBeUndefined();
  });

  it("保留用户自己的钩子和其它顶层键", () => {
    const existing = JSON.stringify({
      "their-hook": { PreInvocation: [{ type: "command", command: "echo hi" }] },
      "ffpane-workbench": {
        PreInvocation: [{ type: "command", command: "echo mine" }],
        PostToolUse: [
          { matcher: "", hooks: [{ command: "node x workbench-hook.mjs AgyPostToolUse" }] },
        ],
      },
    });
    const text = mergeAgyHooksDocument(existing, COMMANDS) ?? "";
    const doc = JSON.parse(text) as Record<string, Record<string, unknown>>;
    expect(doc["their-hook"]).toBeDefined();
    const pre = doc["ffpane-workbench"]?.["PreInvocation"] as Record<string, unknown>[];
    expect(pre.map((item) => item["command"])).toEqual(["echo mine", COMMANDS.AgyPromptSubmit]);
    // 旧版本写进 PostToolUse 的条目要清掉，事件本身也删掉
    expect(doc["ffpane-workbench"]?.["PostToolUse"]).toBeUndefined();
  });

  it("重复写入同一份内容不变（开窗不会反复动用户的文件）", () => {
    const once = mergeAgyHooksDocument(undefined, COMMANDS) ?? "";
    const twice = mergeAgyHooksDocument(once, COMMANDS) ?? "";
    expect(twice).toBe(once);
  });

  it("现有文件坏了就不写", () => {
    expect(mergeAgyHooksDocument("{not json", COMMANDS)).toBeUndefined();
    expect(mergeAgyHooksDocument(JSON.stringify({ "ffpane-workbench": [] }), COMMANDS)).toBe(
      undefined,
    );
  });
});

describe("mergeAgyMcpDocument", () => {
  it("只换本软件管的服务器，用户的原样保留", () => {
    const existing = JSON.stringify({
      mcpServers: {
        mine: { command: "node", args: ["a.js"] },
        "ffpane-workbench": { command: "old" },
      },
    });
    const text =
      mergeAgyMcpDocument(
        existing,
        { "ffpane-workbench": { command: "C:\\electron.exe", args: ["mcp.js"] } },
        ["ffpane-workbench"],
      ) ?? "";
    const servers = (JSON.parse(text) as { mcpServers: Record<string, unknown> }).mcpServers;
    expect(servers["mine"]).toEqual({ command: "node", args: ["a.js"] });
    expect(servers["ffpane-workbench"]).toEqual({
      command: "C:\\electron.exe",
      args: ["mcp.js"],
    });
  });
});

describe("写入位置", () => {
  it("落在项目 .agents 下", () => {
    expect(agyHooksPath("D:\\proj")).toMatch(/\.agents[\\/]hooks\.json$/);
    expect(agyMcpConfigPath("D:\\proj")).toMatch(/\.agents[\\/]mcp_config\.json$/);
  });

  it("拒绝写用户的 ~/.gemini", () => {
    const home = tempDir();
    expect(() =>
      assertNotUserAgyPath(join(home, ".gemini", "config", "hooks.json"), home),
    ).toThrow();
    expect(() =>
      assertNotUserAgyPath(join(home, "proj", ".agents", "hooks.json"), home),
    ).not.toThrow();
  });

  it("真写一遍：文件结构和解析后的内容一致", async () => {
    const project = tempDir();
    const path = await writeAgyProjectHooks({
      projectRoot: project,
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      scriptPath: "D:\\app\\workbench-hook.mjs",
    });
    expect(path).toBe(agyHooksPath(project));
    const doc = JSON.parse(readFileSync(path ?? "", "utf8")) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(["ffpane-workbench"]);
  });

  it("现有文件坏掉时不覆盖", async () => {
    const project = tempDir();
    const broken = join(project, ".agents", "hooks.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(project, ".agents"), { recursive: true });
    writeFileSync(broken, "{broken", "utf8");
    const path = await writeAgyProjectHooks({
      projectRoot: project,
      nodePath: "node.exe",
      scriptPath: "D:\\app\\workbench-hook.mjs",
    });
    expect(path).toBeUndefined();
    expect(readFileSync(broken, "utf8")).toBe("{broken");
  });
});

describe("buildInteractiveAgyArgs", () => {
  it("新开带开场白写成 -i=开场白 放最后，续接用 --conversation", () => {
    expect(buildInteractiveAgyArgs({ permission: "edit", initialPrompt: "你好" })).toEqual([
      "--mode",
      "accept-edits",
      "-i=你好",
    ]);
    expect(buildInteractiveAgyArgs({ permission: "read-only", resumeSessionId: "abc" })).toEqual([
      "--conversation",
      "abc",
      "--mode",
      "plan",
    ]);
  });

  it("全部档带 --dangerously-skip-permissions", () => {
    expect(buildInteractiveAgyArgs({ permission: "yolo" })).toEqual([
      "--dangerously-skip-permissions",
    ]);
  });
});

describe("钩子载荷", () => {
  const roots = JSON.stringify(["D:\\proj"]);

  it("conversationId 从任何事件都能取到", () => {
    expect(
      extractAgyConversationId('{"conversationId":"1ec8c631-12dc-403a-82b1-954803f3fc2e"}'),
    ).toBe("1ec8c631-12dc-403a-82b1-954803f3fc2e");
    expect(extractAgyConversationId("not json")).toBeUndefined();
  });

  it("Stop 的 terminationReason=ERROR 当出错", () => {
    expect(agyStopEvent('{"terminationReason":"NO_TOOL_CALL"}')).toBe("Stop");
    expect(agyStopEvent('{"terminationReason":"ERROR"}')).toBe("StopFailure");
  });

  it("项目内写入放行、项目外拒绝（agi 参数名 CommandLine / TargetFile）", () => {
    const inside = JSON.stringify({
      cwd: "D:\\proj",
      toolCall: { name: "run_command", args: { CommandLine: "echo hi" } },
    });
    expect(agyPreToolUseOutput(inside, roots, "ffpane-workbench")).toBe("");
    const outside = JSON.stringify({
      cwd: "D:\\proj",
      toolCall: { name: "run_command", args: { CommandLine: "copy a C:\\Windows\\evil.txt" } },
    });
    const out = agyPreToolUseOutput(outside, roots, "ffpane-workbench");
    expect(out).not.toBe("");
    expect(JSON.parse(out)).toMatchObject({ decision: "deny" });
  });

  it("工作台 MCP 直连和懒加载都 auto_approve", () => {
    const direct = JSON.stringify({
      cwd: "D:\\proj",
      toolCall: { name: "mcp_ffpane-workbench_ffpane_whoami", args: {} },
    });
    expect(JSON.parse(agyPreToolUseOutput(direct, roots, "ffpane-workbench"))).toEqual({
      decision: "auto_approve",
    });
    const lazy = JSON.stringify({
      cwd: "D:\\proj",
      toolCall: { name: "call_mcp_tool", args: { ServerName: "ffpane-workbench" } },
    });
    expect(JSON.parse(agyPreToolUseOutput(lazy, roots, "ffpane-workbench"))).toEqual({
      decision: "auto_approve",
    });
  });
});

describe("环境与模型", () => {
  it("去掉 Git Bash 变量，大小写都算", () => {
    const out = agyProcessEnv({ MSYSTEM: "MINGW64", Path: "C:\\x" }, {});
    // 键留着但值写成 undefined：终端管理器叠加时才会真的删掉
    expect("MSYSTEM" in out).toBe(true);
    expect(out["MSYSTEM"]).toBeUndefined();
    expect(out["Path"]).toBe("C:\\x");
    // 主进程环境里大小写不同的同名变量也标掉
    expect("msystem" in agyProcessEnv({}, { msystem: "MINGW64" })).toBe(true);
  });

  it("已有代理就不补系统代理", () => {
    const out = agyProxyEnv({ HTTPS_PROXY: "http://a:1" }, () => ({ HTTP_PROXY: "http://b:2" }));
    expect(out).toEqual({});
  });

  it("按协议写的系统代理取 https", () => {
    const settings = parseInternetSettings(
      "    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    http=a:1;https=b:2\n",
    );
    expect(proxyEnvFromSystem(settings)).toMatchObject({ HTTPS_PROXY: "http://b:2" });
  });

  it("agy models 的真实输出（制表符两列）能解析", () => {
    const real = [
      "Fetching available models...",
      "gemini-4-neon-high\tGemini 4 Neon (High)",
      "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
      "claude-opus-5-5-low\tClaude Opus 5.5 (Low)",
    ].join("\n");
    const models = parseAgyModels(real);
    expect(models.map((item) => item.id)).toEqual([
      "gemini-4-neon-high",
      "gemini-3.8-flash-medium",
      "claude-opus-5-5-low",
    ]);
    expect(models[0]?.displayName).toBe("Gemini 4 Neon (High)");
    expect(models.every((item) => !item.isDefault)).toBe(true);
  });

  it("旧格式和带 default 标记的也能认", () => {
    const models = parseAgyModels("gemini-3.5-flash - Gemini 3.5 Flash (default)\ngemini-3-pro\n");
    expect(models.map((item) => item.id)).toEqual(["gemini-3.5-flash", "gemini-3-pro"]);
    expect(models[0]?.isDefault).toBe(true);
  });
});

describe("buildInteractiveAgyArgs：-i 绝不能吃掉后面的开关（真机复现的启动失败）", () => {
  it("带模型、强度、开场白时，-i=开场白 在最后，前面没有单独的 -i", () => {
    const args = buildInteractiveAgyArgs({
      permission: "read-only",
      model: "gemini-4-carbon-low",
      effort: "low",
      initialPrompt: "只回复 OK",
    });
    expect(args).toEqual([
      "--mode",
      "plan",
      "--model",
      "gemini-4-carbon-low",
      "--effort",
      "low",
      "-i=只回复 OK",
    ]);
    expect(args).not.toContain("-i");
    expect(args[args.length - 1]?.startsWith("-i=")).toBe(true);
  });

  it("没有开场白就不带 -i", () => {
    expect(buildInteractiveAgyArgs({ permission: "edit" })).toEqual(["--mode", "accept-edits"]);
  });
});
