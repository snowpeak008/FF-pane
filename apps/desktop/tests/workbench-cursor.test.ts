/**
 * T11.10：Cursor 窗口。找 CLI、组参数、插件目录和项目钩子、钩子脚本的 Cursor 分支、整条启动。
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createWindowTokenRegistry } from "@ff-pane/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PtyManager } from "../src/main/terminal/manager";
import { createWorkbenchAuthRegistry } from "../src/main/workbench/auth-registry";
import { buildInteractiveCursorArgs } from "../src/main/workbench/cli-args";
import {
  type CursorFs,
  cursorProcessEnv,
  cursorProxyEnv,
  parseCursorModels,
  parseInternetSettings,
  pickLatestCursorVersion,
  proxyEnvFromSystem,
  resolveCursorCliTarget,
} from "../src/main/workbench/cursor-cli";
import {
  assertNotUserCursorPath,
  cursorHookCommand,
  cursorMcpAllowRule,
  cursorProjectDir,
  mergeCursorCliConfigDocument,
  mergeCursorHooksDocument,
} from "../src/main/workbench/cursor-hook-config";
import { launchCliWindow } from "../src/main/workbench/launch-cli";
import { WorkbenchMcpTempRegistry } from "../src/main/workbench/mcp-temp";
import type { LaunchCliRoute } from "../src/main/workbench/resolve-config";
import { asciiJson, cursorStopEvent, cursorWriteGuardOutput } from "../src/mcp/workbench-hook";

describe("找 Cursor CLI", () => {
  it("取日期最新的版本目录，同一天按时间", () => {
    expect(
      pickLatestCursorVersion([
        "2026.11.05-86047df",
        "2026.9.30-aaaaaaa",
        "2026.11.05-01-02-03-bbbbbbb",
        "promote-staged.cmd",
      ]),
    ).toBe("2026.11.05-01-02-03-bbbbbbb");
    expect(pickLatestCursorVersion(["junk"])).toBeUndefined();
  });

  it("在 LOCALAPPDATA\\cursor-agent\\versions 里找 node.exe 和 index.js", () => {
    const root = join("C:\\Users\\u\\AppData\\Local", "cursor-agent");
    const ver = join(root, "versions", "2026.11.05-86047df");
    const files = new Set([join(ver, "node.exe"), join(ver, "index.js")]);
    const dirs = new Set([join(root, "versions"), ver]);
    const fs: CursorFs = {
      exists: (path) => files.has(path) || dirs.has(path),
      isDirectory: (path) => dirs.has(path),
      listDir: (path) => (path === join(root, "versions") ? ["2026.11.05-86047df"] : []),
    };
    expect(resolveCursorCliTarget({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, fs)).toEqual({
      nodeFile: join(ver, "node.exe"),
      indexJs: join(ver, "index.js"),
      version: "2026.11.05-86047df",
    });
    expect(resolveCursorCliTarget({}, fs)).toBeUndefined();
  });

  it("进程环境去掉会让钩子走 Git Bash 的变量，补上 CURSOR_INVOKED_AS", () => {
    const env = cursorProcessEnv({
      MSYSTEM: "MINGW64",
      exepath: "E:\\git\\bin",
      SHELL: "/usr/bin/bash",
      LOCALAPPDATA: "C:\\L",
      KEEP: "1",
    });
    expect(env["MSYSTEM"]).toBeUndefined();
    expect(env["exepath"]).toBeUndefined();
    expect(env["SHELL"]).toBeUndefined();
    // 写成 undefined，终端管理器叠到主进程环境上时才会删掉
    expect(Object.hasOwn(env, "MSYSTEM")).toBe(true);
    expect(Object.hasOwn(env, "EXEPATH")).toBe(true);
    expect(env["KEEP"]).toBe("1");
    expect(env["CURSOR_INVOKED_AS"]).toBe("cursor-agent");
    expect(env["NODE_COMPILE_CACHE"]).toBe(join("C:\\L", "cursor-compile-cache"));
  });

  it("系统代理：开着就照它设 HTTPS_PROXY；按协议分开写的取 https；环境里已有代理就不动", () => {
    const reg = [
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "    ProxyEnable    REG_DWORD    0x1",
      "    ProxyServer    REG_SZ    127.0.0.1:7897",
      "    ProxyOverride    REG_SZ    localhost;127.*;<local>",
    ].join("\r\n");
    const settings = parseInternetSettings(reg);
    expect(settings).toEqual({ enabled: true, server: "127.0.0.1:7897" });
    expect(proxyEnvFromSystem(settings)).toEqual({
      HTTPS_PROXY: "http://127.0.0.1:7897",
      HTTP_PROXY: "http://127.0.0.1:7897",
      NO_PROXY: "localhost,127.0.0.1,::1",
    });
    expect(
      proxyEnvFromSystem({ enabled: true, server: "http=10.0.0.1:80;https=10.0.0.2:443" })[
        "HTTPS_PROXY"
      ],
    ).toBe("http://10.0.0.2:443");
    expect(proxyEnvFromSystem({ enabled: false, server: "127.0.0.1:7897" })).toEqual({});
    expect(parseInternetSettings("    ProxyEnable    REG_DWORD    0x0").enabled).toBe(false);
    const system = () => ({ HTTPS_PROXY: "http://sys:1" });
    expect(cursorProxyEnv({ https_proxy: "http://mine:2" }, system)).toEqual({});
    expect(cursorProxyEnv({ PATH: "x" }, system)).toEqual({ HTTPS_PROXY: "http://sys:1" });
  });

  it("解析 cursor-agent models 的输出", () => {
    const models = parseCursorModels(
      "Available models\n\nauto - Auto (current, default)\ngrok-4.7-low-fast - Grok 4.7  Low Fast\u200b\u200b\nkimi-k3-max - Kimi K3 (current)\n\nTip: use --model <id>",
    );
    expect(models).toEqual([
      { id: "auto", displayName: "Auto", isDefault: true },
      { id: "grok-4.7-low-fast", displayName: "Grok 4.7  Low Fast", isDefault: false },
      { id: "kimi-k3-max", displayName: "Kimi K3", isDefault: false },
    ]);
  });
});

describe("Cursor 启动参数", () => {
  it("新开不带编号；续接 --resume；权限按表；插件目录带 --approve-mcps", () => {
    expect(
      buildInteractiveCursorArgs({ permission: "edit", pluginDir: "D:\\p", model: "auto" }),
    ).toEqual(["--trust", "--model", "auto", "--approve-mcps", "--plugin-dir", "D:\\p"]);
    expect(
      buildInteractiveCursorArgs({
        resumeSessionId: "8cee0097-9d0e-4e52-9390-a6f7bc882424",
        permission: "yolo",
        initialPrompt: "开始",
      }),
    ).toEqual(["--trust", "--resume", "8cee0097-9d0e-4e52-9390-a6f7bc882424", "--force", "开始"]);
    expect(buildInteractiveCursorArgs({ permission: "read-only" })).toEqual([
      "--trust",
      "--mode",
      "plan",
    ]);
  });
});

describe("Cursor 项目钩子", () => {
  const commands = {
    sessionStart: '"C:\\node.exe" "D:\\out\\workbench-hook.mjs" CursorSessionStart',
    beforeSubmitPrompt: '"C:\\node.exe" "D:\\out\\workbench-hook.mjs" CursorPromptSubmit',
    preToolUse: '"C:\\node.exe" "D:\\out\\workbench-hook.mjs" CursorPreToolUse',
    postToolUse: '"C:\\node.exe" "D:\\out\\workbench-hook.mjs" CursorPostToolUse',
    stop: '"C:\\node.exe" "D:\\out\\workbench-hook.mjs" CursorStop',
  };

  it("没有文件就新建；用户自己的条目留着；本软件旧的条目换成新的，不重复", () => {
    const fresh = JSON.parse(mergeCursorHooksDocument(undefined, commands) ?? "{}");
    expect(fresh.version).toBe(1);
    expect(fresh.hooks.stop).toEqual([{ command: commands.stop }]);
    const existing = JSON.stringify({
      version: 1,
      hooks: {
        stop: [
          { command: "my-own-script.ps1" },
          { command: '"C:\\old\\node.exe" "D:\\old\\workbench-hook.mjs" CursorStop' },
        ],
        afterFileEdit: [{ command: "format.ps1" }],
        sessionEnd: [{ command: '"C:\\old\\node.exe" "D:\\old\\workbench-hook.mjs" CursorStop' }],
      },
    });
    const merged = JSON.parse(mergeCursorHooksDocument(existing, commands) ?? "{}");
    expect(merged.hooks.stop).toEqual([
      { command: "my-own-script.ps1" },
      { command: commands.stop },
    ]);
    expect(merged.hooks.afterFileEdit).toEqual([{ command: "format.ps1" }]);
    expect(merged.hooks.sessionEnd).toBeUndefined();
    const again = mergeCursorHooksDocument(JSON.stringify(merged), commands);
    expect(JSON.parse(again ?? "{}")).toEqual(merged);
  });

  it("现有文件坏了就不写", () => {
    expect(mergeCursorHooksDocument("{not json", commands)).toBeUndefined();
    expect(mergeCursorHooksDocument('{"hooks":{"stop":{}}}', commands)).toBeUndefined();
    expect(mergeCursorHooksDocument("[]", commands)).toBeUndefined();
  });

  it("命令路径里有引号或 PowerShell 会展开的字符就不装", () => {
    expect(
      cursorHookCommand(
        "C:\\Program Files\\nodejs\\node.exe",
        "D:\\a\\workbench-hook.mjs",
        "CursorStop",
      ),
    ).toBe('"C:\\Program Files\\nodejs\\node.exe" "D:\\a\\workbench-hook.mjs" CursorStop');
    expect(cursorHookCommand("C:\\$x\\node.exe", "D:\\a.mjs", "CursorStop")).toBeUndefined();
    expect(cursorHookCommand("C:\\node.exe", 'D:\\"a.mjs', "CursorStop")).toBeUndefined();
  });

  it("项目目录是 git 根；不在 git 里就是工作目录；不写 ~/.cursor", () => {
    const has = new Set([join("D:\\repo", ".git")]);
    expect(cursorProjectDir("D:\\repo\\sub\\dir", (path) => has.has(path))).toBe("D:\\repo");
    expect(cursorProjectDir("E:\\plain", () => false)).toBe("E:\\plain");
    expect(() =>
      assertNotUserCursorPath(join("C:\\Users\\u", ".cursor", "hooks.json"), "C:\\Users\\u"),
    ).toThrow();
    expect(() =>
      assertNotUserCursorPath(join("D:\\repo", ".cursor", "hooks.json"), "C:\\Users\\u"),
    ).not.toThrow();
  });
});

describe("Cursor 项目权限（放行工作台 MCP）", () => {
  const rule = cursorMcpAllowRule("ffpane-workbench");

  it("加一条放行规则；别的键和用户规则留着；已有就原样不动；坏文件不写", () => {
    expect(rule).toBe("Mcp(*ffpane-workbench:*)");
    expect(JSON.parse(mergeCursorCliConfigDocument(undefined, [rule]) ?? "{}")).toEqual({
      permissions: { allow: [rule], deny: [] },
    });
    // deny 缺了 Cursor 整个起不来：补上
    expect(
      JSON.parse(
        mergeCursorCliConfigDocument(JSON.stringify({ permissions: { allow: [rule] } }), [rule]) ??
          "{}",
      ),
    ).toEqual({ permissions: { allow: [rule], deny: [] } });
    const existing = JSON.stringify({
      permissions: { allow: ["Shell(ls)"], deny: ["Shell(rm)"] },
      editor: { vimMode: true },
    });
    const merged = mergeCursorCliConfigDocument(existing, [rule]) ?? "";
    expect(JSON.parse(merged)).toEqual({
      permissions: { allow: ["Shell(ls)", rule], deny: ["Shell(rm)"] },
      editor: { vimMode: true },
    });
    expect(mergeCursorCliConfigDocument(merged, [rule])).toBe(merged);
    expect(mergeCursorCliConfigDocument("{bad", [rule])).toBeUndefined();
    expect(mergeCursorCliConfigDocument('{"permissions":{"allow":"x"}}', [rule])).toBeUndefined();
  });
});

describe("钩子脚本的 Cursor 分支（纯函数）", () => {
  const roots = JSON.stringify(["D:\\proj"]);

  it("改项目外的文件、Shell 写项目外：拒绝，Cursor 的格式", () => {
    const denied = cursorWriteGuardOutput(
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: "E:\\other\\a.txt" } }),
      roots,
    );
    const parsed = JSON.parse(denied);
    expect(parsed.permission).toBe("deny");
    expect(parsed.agent_message).toContain("不能写到项目外");
    expect(
      cursorWriteGuardOutput(
        JSON.stringify({ tool_name: "Write", tool_input: { file_path: "D:\\proj\\a.txt" } }),
        roots,
      ),
    ).toBe("");
    expect(
      JSON.parse(
        cursorWriteGuardOutput(
          JSON.stringify({
            tool_name: "Shell",
            tool_input: { command: "Set-Content -Path E:\\x.txt -Value 1", cwd: "D:\\proj" },
          }),
          roots,
        ),
      ).permission,
    ).toBe("deny");
    expect(
      cursorWriteGuardOutput(
        JSON.stringify({ tool_name: "Read", tool_input: { file_path: "E:\\x.txt" } }),
        roots,
      ),
    ).toBe("");
    expect(cursorWriteGuardOutput("{}", undefined)).toBe("");
  });

  it("stop：error 当出错结束，其余当正常结束", () => {
    expect(cursorStopEvent('{"status":"completed"}')).toBe("Stop");
    expect(cursorStopEvent('{"status":"aborted"}')).toBe("Stop");
    expect(cursorStopEvent('{"status":"error"}')).toBe("StopFailure");
    expect(cursorStopEvent("garbage")).toBe("Stop");
  });

  it("输出只有 ASCII，读回来内容不变", () => {
    const text = asciiJson({ additional_context: "你是管理者 ✓" });
    expect(/^[\x20-\x7e]*$/.test(text)).toBe(true);
    expect(JSON.parse(text)).toEqual({ additional_context: "你是管理者 ✓" });
  });
});

const hookSource = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "mcp",
  "workbench-hook.ts",
);
const tsExtRegister = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "ts-ext-register.mjs"),
).href;

async function runCursorHook(
  event: string,
  stdin: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; requests: Record<string, unknown>[] }> {
  const pipe =
    process.platform === "win32"
      ? `\\\\.\\pipe\\ffpane-cursor-hook-test-${randomUUID()}`
      : join("/tmp", `ffpane-cursor-hook-test-${randomUUID()}.sock`);
  const requests: Record<string, unknown>[] = [];
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (data) => {
      buf += data.toString();
      const index = buf.indexOf("\n");
      if (index < 0) {
        return;
      }
      const req = JSON.parse(buf.slice(0, index)) as Record<string, unknown>;
      requests.push(req);
      socket.write(
        `${JSON.stringify(
          req["type"] === "inbox-digest"
            ? { ok: true, result: { text: "正文：青蛙七号" } }
            : req["type"] === "inbox-midturn"
              ? { ok: true, result: { text: "[平台] 上级说先停" } }
              : { ok: true },
        )}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(pipe, resolve));
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "--import", tsExtRegister, hookSource, event],
        {
          env: { ...process.env, FF_PANE_WB_PIPE: pipe, FF_PANE_WINDOW_TOKEN: "tok", ...extraEnv },
          stdio: ["pipe", "pipe", "ignore"],
        },
      );
      let out = "";
      child.stdout.on("data", (data) => {
        out += data.toString();
      });
      child.on("error", reject);
      child.on("exit", () => resolve(out));
      child.stdin.end(JSON.stringify(stdin));
    });
    return { stdout, requests };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("钩子脚本的 Cursor 分支（真起进程）", () => {
  const scratch = mkdtempSync(join(tmpdir(), "ffpane-cursor-hook-"));
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });
  const sessionId = "8cee0097-9d0e-4e52-9390-a6f7bc882424";

  it("sessionStart：报 SessionStart 和编号，交出说明并删掉说明文件", async () => {
    const contextFile = join(scratch, "ctx-1.md");
    writeFileSync(contextFile, "你是执行窗口。", "utf8");
    const result = await runCursorHook(
      "CursorSessionStart",
      { hook_event_name: "sessionStart", session_id: sessionId, conversation_id: sessionId },
      { FF_PANE_CURSOR_CONTEXT_FILE: contextFile },
    );
    expect(result.requests).toEqual([
      { v: 1, type: "hook", token: "tok", event: "SessionStart", sessionId },
    ]);
    expect(JSON.parse(result.stdout.trim())).toEqual({ additional_context: "你是执行窗口。" });
    expect(existsSync(contextFile)).toBe(false);
  }, 20_000);

  it("提交新消息提醒：先交还没交的说明，再附上未读正文", async () => {
    const contextFile = join(scratch, "ctx-2.md");
    writeFileSync(contextFile, "你是检查窗口。", "utf8");
    const result = await runCursorHook(
      "CursorPromptSubmit",
      { session_id: sessionId, prompt: "[新消息] 来自 总管（管理者）：消息，id m-1。" },
      { FF_PANE_CURSOR_CONTEXT_FILE: contextFile },
    );
    expect(result.requests.map((req) => `${req["type"]}:${req["event"] ?? ""}`)).toEqual([
      "hook:UserPromptSubmit",
      "inbox-digest:",
    ]);
    expect(result.requests[0]?.["sessionId"]).toBe(sessionId);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      additional_context: "你是检查窗口。\n\n正文：青蛙七号",
    });
  }, 20_000);

  it("postToolUse 插中途消息；stop 出错报 StopFailure", async () => {
    const post = await runCursorHook("CursorPostToolUse", {
      tool_name: "Shell",
      tool_use_id: "fed26426-0a6e-4f2c-961d-6faf51d92346",
      tool_input: { command: "echo" },
    });
    expect(post.requests.map((req) => req["type"])).toEqual(["hook", "inbox-midturn"]);
    expect(JSON.parse(post.stdout.trim())).toEqual({ additional_context: "[平台] 上级说先停" });
    const stop = await runCursorHook("CursorStop", { status: "error" });
    expect(stop.requests).toEqual([
      { v: 1, type: "hook", token: "tok", event: "StopFailure", errorType: "unknown" },
    ]);
    expect(stop.stdout.trim()).toBe("");
  }, 20_000);

  it("没有窗口令牌（在 Cursor 编辑器里跑到）：什么也不做", async () => {
    const result = await runCursorHook(
      "CursorStop",
      { status: "completed" },
      { FF_PANE_WINDOW_TOKEN: "" },
    );
    expect(result.requests).toEqual([]);
    expect(result.stdout.trim()).toBe("");
  }, 20_000);
});

describe("launchCliWindow Cursor", () => {
  const fakeLocal = mkdtempSync(join(tmpdir(), "ffpane-cursor-local-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "ffpane-cursor-proj-"));
  const version = join(fakeLocal, "cursor-agent", "versions", "2026.11.05-86047df");
  const saved: Record<string, string | undefined> = {};
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";

  beforeAll(() => {
    mkdirSync(version, { recursive: true });
    writeFileSync(join(version, "node.exe"), "", "utf8");
    writeFileSync(join(version, "index.js"), "", "utf8");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    mkdirSync(join(projectRoot, ".cursor"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".cursor", "hooks.json"),
      JSON.stringify({ version: 1, hooks: { stop: [{ command: "mine.ps1" }] } }),
      "utf8",
    );
    for (const key of ["LOCALAPPDATA", pathKey, "MSYSTEM", "SHELL"]) {
      saved[key] = process.env[key];
    }
    process.env["LOCALAPPDATA"] = fakeLocal;
    // 本机 PATH 上可能有真的 cursor-agent，测试里只留不含它的目录
    process.env[pathKey] = (process.env[pathKey] ?? "")
      .split(";")
      .filter((dir) => dir.trim() !== "" && !existsSync(join(dir, "cursor-agent.cmd")))
      .join(";");
    process.env["MSYSTEM"] = "MINGW64";
    process.env["SHELL"] = "/usr/bin/bash";
  });

  afterEach(() => undefined);

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(fakeLocal, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function route(partial?: Partial<LaunchCliRoute>): LaunchCliRoute {
    return {
      connectionMode: "local_cli",
      configId: "cfg" as LaunchCliRoute["configId"],
      configName: "默认配置",
      ...partial,
    };
  }

  function deps(
    captured: { env: Record<string, string | undefined>; file: string; args: readonly string[] }[],
  ) {
    const manager = {
      aliveCount: () => 0,
      create: (input: {
        env: Record<string, string>;
        direct: { file: string; args: readonly string[] };
      }) => {
        captured.push({
          env: { ...input.env },
          file: input.direct.file,
          args: [...input.direct.args],
        });
        return { id: `term-${captured.length}` };
      },
    } as unknown as PtyManager;
    return {
      manager,
      getProvider: async () => undefined,
      revealSecret: async () => undefined,
      getMaxWorkbenchWindows: async () => 8,
      isKnowledgeToolEnabled: async () => false,
      isConfigToolEnabled: async () => true,
      getKnowledgeToolSettings: async () => undefined,
      indexDbFile: join(projectRoot, "index.db"),
      moduleDir: projectRoot,
      mcpRegistry: new WorkbenchMcpTempRegistry(),
      clampMax: (value: unknown) => (typeof value === "number" ? value : 8),
      limitErrorPrefix: "limit",
      tokenRegistry: createWindowTokenRegistry(),
      authRegistry: createWorkbenchAuthRegistry(),
      controlPipe: "\\\\.\\pipe\\ff-pane-wb-cursor",
      hookScriptPath: join(projectRoot, "out", "workbench-hook.mjs"),
      loadRoleInjection: async () => ({ developerInstructions: "按角色说明行事" }),
      resolveConfigTool: async () => ({
        "ffpane-config": {
          command: "electron.exe",
          args: ["config-mcp.js"],
          env: { FF_PANE_CONFIG_MAILBOX: "D:\\mailbox" },
        },
      }),
    };
  }

  it("新开：直启版本目录的 node，插件里的 MCP 只有占位符，项目钩子合并写入，说明交给钩子", async () => {
    const captured: {
      env: Record<string, string | undefined>;
      file: string;
      args: readonly string[];
    }[] = [];
    const result = await launchCliWindow(
      {
        windowId: "win-cursor",
        projectId: "proj" as never,
        projectRoot,
        kind: "cursor",
        route: route({ model: "auto" }),
        cols: 80,
        rows: 24,
        role: "manager",
        permission: "edit",
      },
      deps(captured),
    );
    expect(result.kind).toBe("cursor");
    expect(result.nativeSessionId).toBeUndefined();
    expect(result.turnSignal).toBe("auto");
    expect(result.command).toBe("cursor-agent");
    const launched = captured[0];
    expect(launched?.file).toBe(join(version, "node.exe"));
    const args = launched?.args ?? [];
    expect(args[0]).toBe(join(version, "index.js"));
    expect(args).toContain("--approve-mcps");
    expect(args).toContain("auto");
    expect(args).not.toContain("--resume");
    const env = launched?.env ?? {};
    expect(env["MSYSTEM"]).toBeUndefined();
    expect(Object.hasOwn(env, "MSYSTEM")).toBe(true);
    expect(env["SHELL"]).toBeUndefined();
    expect(Object.hasOwn(env, "SHELL")).toBe(true);
    expect(env["CURSOR_INVOKED_AS"]).toBe("cursor-agent");
    expect(env["FF_PANE_WRITE_ROOTS"]).toContain(projectRoot.replaceAll("\\", "\\\\"));
    expect(env["FF_PANE_CONFIG_MAILBOX"]).toBe("D:\\mailbox");
    const token = env["FF_PANE_WINDOW_TOKEN"] ?? "";
    expect(token.length).toBeGreaterThan(32);

    const pluginDir = args[args.indexOf("--plugin-dir") + 1] ?? "";
    const mcp = readFileSync(join(pluginDir, "mcp.json"), "utf8");
    expect(mcp).toContain(`${"$"}{env:FF_PANE_WINDOW_TOKEN}`);
    expect(mcp).toContain(`${"$"}{env:FF_PANE_CONFIG_MAILBOX}`);
    expect(mcp).toContain("ffpane-workbench");
    expect(mcp).not.toContain(token);
    expect(mcp).not.toContain("D:\\\\mailbox");

    const contextFile = env["FF_PANE_CURSOR_CONTEXT_FILE"] ?? "";
    expect(readFileSync(contextFile, "utf8")).toBe("按角色说明行事");

    const hooks = JSON.parse(readFileSync(join(projectRoot, ".cursor", "hooks.json"), "utf8"));
    expect(hooks.hooks.stop[0]).toEqual({ command: "mine.ps1" });
    expect(hooks.hooks.stop[1].command).toMatch(/workbench-hook\.mjs" CursorStop$/);
    expect(Object.keys(hooks.hooks).sort()).toEqual(
      ["beforeSubmitPrompt", "postToolUse", "preToolUse", "sessionStart", "stop"].sort(),
    );
    expect(JSON.stringify(hooks)).not.toContain(token);
    const cli = JSON.parse(readFileSync(join(projectRoot, ".cursor", "cli.json"), "utf8"));
    expect(cli.permissions).toEqual({ allow: ["Mcp(*ffpane-workbench:*)"], deny: [] });
    expect(pluginDir.endsWith(join("ffpane"))).toBe(true);
  });

  it("续接带编号走 --resume；没编号报错；全部权限加 --force；第二次开不重复写钩子", async () => {
    const captured: {
      env: Record<string, string | undefined>;
      file: string;
      args: readonly string[];
    }[] = [];
    const id = "8cee0097-9d0e-4e52-9390-a6f7bc882424";
    const result = await launchCliWindow(
      {
        windowId: "win-cursor-2",
        projectId: "proj" as never,
        projectRoot,
        kind: "cursor",
        route: route(),
        cols: 80,
        rows: 24,
        resume: true,
        nativeSessionId: id,
        permission: "yolo",
      },
      deps(captured),
    );
    expect(result.nativeSessionId).toBe(id);
    const args = captured[0]?.args ?? [];
    expect(args.slice(1, 5)).toEqual(["--trust", "--resume", id, "--force"]);
    const hooks = JSON.parse(readFileSync(join(projectRoot, ".cursor", "hooks.json"), "utf8"));
    expect(hooks.hooks.stop).toHaveLength(2);
    await expect(
      launchCliWindow(
        {
          windowId: "win-cursor-3",
          projectId: "proj" as never,
          projectRoot,
          kind: "cursor",
          route: route(),
          cols: 80,
          rows: 24,
          resume: true,
        },
        deps(captured),
      ),
    ).rejects.toThrow(/续接要有对话编号/);
  });
});
