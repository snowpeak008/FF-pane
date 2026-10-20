/**
 * 新消息提醒的 UserPromptSubmit hook：真起一个 hook 进程，对着假控制通道走完整流程。
 * 回归：上报连接不读回执时，进程会在取正文之前退出（2026-10-20 实测）。
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const hookSource = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "mcp",
  "workbench-hook.ts",
);

async function runHook(
  prompt: string,
  event = "UserPromptSubmit",
  stdin: Record<string, unknown> = { hook_event_name: "UserPromptSubmit", prompt },
): Promise<{ stdout: string; requests: string[] }> {
  const pipe =
    process.platform === "win32"
      ? `\\\\.\\pipe\\ffpane-hook-test-${randomUUID()}`
      : join("/tmp", `ffpane-hook-test-${randomUUID()}.sock`);
  const requests: string[] = [];
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (data) => {
      buf += data.toString();
      const index = buf.indexOf("\n");
      if (index < 0) {
        return;
      }
      const req = JSON.parse(buf.slice(0, index)) as {
        type: string;
        token: string;
        event?: string;
        errorType?: string;
      };
      requests.push(
        `${req.type}:${req.token}${req.event === "StopFailure" ? `:${req.event}:${req.errorType}` : ""}`,
      );
      socket.write(
        `${JSON.stringify(
          req.type === "inbox-digest"
            ? { ok: true, result: { text: "正文：青蛙七号" } }
            : { ok: true },
        )}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(pipe, resolve));
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", hookSource, event], {
        env: { ...process.env, FF_PANE_WB_PIPE: pipe, FF_PANE_WINDOW_TOKEN: "tok" },
        stdio: ["pipe", "pipe", "ignore"],
      });
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

describe("新消息 hook 进程", () => {
  it("提交的是新消息提醒：先上报，再取正文，输出附加上下文", async () => {
    const result = await runHook("[新消息] 来自 总管（管理者）：消息，id m-1。");
    expect(result.requests).toEqual(["hook:tok", "inbox-digest:tok"]);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "正文：青蛙七号",
      },
    });
  }, 20_000);

  it("普通输入只上报，不取正文，不写 stdout", async () => {
    const result = await runHook("帮我看看 [新消息] 这个词");
    expect(result.requests).toEqual(["hook:tok"]);
    expect(result.stdout.trim()).toBe("");
  }, 20_000);

  it("API 错误（StopFailure）：只转发错误类型，不转发错误正文", async () => {
    const result = await runHook("", "StopFailure", {
      hook_event_name: "StopFailure",
      error: "rate_limit",
      error_details: "429 Too Many Requests 密钥 sk-xxx",
      last_assistant_message: "API Error: Rate limit reached",
    });
    expect(result.requests).toEqual(["hook:tok:StopFailure:rate_limit"]);
    const odd = await runHook("", "StopFailure", { error: "Rate Limit; rm -rf" });
    expect(odd.requests).toEqual(["hook:tok:StopFailure:unknown"]);
  }, 20_000);
});
