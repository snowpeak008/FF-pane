/**
 * T10.18：Grok 钩子只写一个没有空格的程序路径。令牌不进文件。对话编号用来区分窗口。
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWindowTokenRegistry } from "@ff-pane/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkbenchControlServer,
  mapHookEvent,
  type WorkbenchControlServer,
} from "../src/main/workbench/control-channel";
import {
  buildGrokWorkbenchHookDocument,
  grokHookCommandIsDirect,
  grokHookSessionMatches,
  selectGrokHookCommand,
  writeGrokWorkbenchHookFile,
} from "../src/main/workbench/grok-hook-config";

const servers: WorkbenchControlServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      await server.close();
    }
  }
});

const directExe =
  process.platform === "win32"
    ? "C:\\ffpane\\ffpane-grok-hook.exe"
    : "/ffpane/ffpane-grok-hook.exe";
const spacedExe =
  process.platform === "win32"
    ? "C:\\Program Files\\ffpane-grok-hook.exe"
    : "/tmp/my hooks/ffpane-grok-hook.exe";

describe("Grok 钩子路径", () => {
  it("没有空格才算能直接启动", () => {
    expect(grokHookCommandIsDirect(directExe)).toBe(true);
    expect(grokHookCommandIsDirect(spacedExe)).toBe(false);
    expect(grokHookCommandIsDirect(`${directExe} Stop`)).toBe(false);
    expect(grokHookCommandIsDirect("node")).toBe(false);
  });

  it("有空格就不装；没有空格不复制", () => {
    expect(selectGrokHookCommand({ bundledPath: spacedExe, bundledExists: true })).toEqual({
      copy: false,
    });
    expect(
      selectGrokHookCommand({
        bundledPath: spacedExe,
        bundledExists: true,
        fallbackPath: directExe,
      }),
    ).toEqual({ command: directExe, copy: true });
    expect(
      selectGrokHookCommand({
        bundledPath: directExe,
        bundledExists: true,
        fallbackPath: spacedExe,
      }),
    ).toEqual({ command: directExe, copy: false });
  });

  it("钩子文件的 command 只有程序路径，没有令牌", () => {
    const body = buildGrokWorkbenchHookDocument(directExe);
    const parsed = JSON.parse(body) as {
      hooks: Record<
        string,
        { matcher?: string; hooks: { command: string; args?: string[]; env?: unknown }[] }[]
      >;
    };
    expect(parsed.hooks["Stop"]?.[0]?.hooks[0]?.command).toBe(directExe);
    expect(parsed.hooks["StopFailure"]?.[0]?.hooks[0]?.command).toBe(directExe);
    expect(parsed.hooks["StopCancelled"]?.[0]?.hooks[0]?.command).toBe(directExe);
    expect(parsed.hooks["PermissionDenied"]?.[0]?.hooks[0]?.command).toBe(directExe);
    expect(parsed.hooks["Notification"]?.[0]?.matcher).toBe("permission_prompt");
    expect(parsed.hooks["Notification"]?.[0]?.hooks[0]?.command).toBe(directExe);
    for (const groups of Object.values(parsed.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          expect(hook.command).toBe(directExe);
          expect(hook.args).toBeUndefined();
          expect(hook.env).toBeUndefined();
          expect(hook.command).not.toContain("node");
        }
      }
    }
    expect(body).not.toContain("FF_PANE_WINDOW_TOKEN");
    expect(() => buildGrokWorkbenchHookDocument(spacedExe)).toThrow(/without spaces/);
  });

  it("不写用户目录里的钩子", async () => {
    await expect(
      writeGrokWorkbenchHookFile({ projectRoot: join(homedir(), ".grok"), command: directExe }),
    ).rejects.toThrow(/user ~\/\.grok/);
    await expect(
      writeGrokWorkbenchHookFile({ projectRoot: join(homedir(), ".claude"), command: directExe }),
    ).rejects.toThrow(/user ~\/\.claude/);
    await expect(
      writeGrokWorkbenchHookFile({ projectRoot: join(homedir(), ".cursor"), command: directExe }),
    ).rejects.toThrow(/user ~\/\.cursor/);
  });

  it("对话编号对不上就丢掉", () => {
    expect(grokHookSessionMatches("aaa", "aaa")).toBe(true);
    expect(grokHookSessionMatches("aaa", "bbb")).toBe(false);
    expect(grokHookSessionMatches(undefined, "bbb")).toBe(true);
    expect(grokHookSessionMatches("aaa", undefined)).toBe(true);
  });

  it("结束、失败、取消和权限等待都有信号", () => {
    expect(mapHookEvent("StopFailure")).toBe("stop");
    expect(mapHookEvent("StopCancelled")).toBe("stop");
    expect(mapHookEvent("PermissionDenied")).toBe("permission-request");
    expect(mapHookEvent("Notification", "permission_prompt")).toBe("permission-request");
    expect(mapHookEvent("Notification", "idle_prompt")).toBe("ignore");
  });
});

describe("ffpane-grok-hook.exe", () => {
  const exe = fileURLToPath(new URL("../resources/ffpane-grok-hook.exe", import.meta.url));

  it("不带参数，从环境和标准输入上报回合结束", async () => {
    if (process.platform !== "win32") {
      return;
    }
    const registry = createWindowTokenRegistry();
    const token = registry.issue("win-exe");
    const seen: { event: string; sessionId?: string }[] = [];
    const server = await createWorkbenchControlServer({
      tokens: registry,
      onHook: (_windowId, signal, meta) => {
        seen.push({
          event: signal,
          ...(meta?.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
        });
      },
    });
    servers.push(server);
    const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await new Promise<void>((resolve, reject) => {
      const child = spawn(exe, [], {
        shell: false,
        env: {
          ...process.env,
          GROK_HOOK_EVENT: "stop",
          GROK_SESSION_ID: sessionId,
          FF_PANE_WB_PIPE: server.address,
          FF_PANE_WINDOW_TOKEN: token,
        },
      });
      child.stdin.end('{"hookEventName":"stop","sessionId":"ignored"}\n');
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("hook exe timed out"));
      }, 8_000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    expect(seen).toEqual([{ event: "stop", sessionId }]);
  });
});
