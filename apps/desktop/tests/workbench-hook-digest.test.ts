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
  peekText?: string,
  midTurnText?: string,
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
            : req.type === "inbox-peek" && peekText !== undefined
              ? { ok: true, result: { text: peekText } }
              : req.type === "inbox-midturn"
                ? { ok: true, result: { text: midTurnText ?? "" } }
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

  it("普通输入：上报后只问有没有未读，不取正文；没有未读不写 stdout", async () => {
    const result = await runHook("帮我看看 [新消息] 这个词");
    expect(result.requests).toEqual(["hook:tok", "inbox-peek:tok"]);
    expect(result.stdout.trim()).toBe("");
  }, 20_000);

  it("普通输入、收件箱有未读：附一句未读提示", async () => {
    const result = await runHook("接着做", "UserPromptSubmit", undefined, "[平台] 另有 2 条未读");
    expect(result.requests).toEqual(["hook:tok", "inbox-peek:tok"]);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "[平台] 另有 2 条未读",
      },
    });
  }, 20_000);

  it("干活中途（PostToolUse）：上报后问有没有该插的消息，有就作为附加上下文插进去（T11.7）", async () => {
    const stdin = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_1" };
    const result = await runHook("", "PostToolUse", stdin, undefined, "[平台] 上级说先别提交");
    expect(result.requests).toEqual(["hook:tok", "inbox-midturn:tok"]);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "[平台] 上级说先别提交",
      },
    });
    const failed = await runHook(
      "",
      "PostToolUseFailure",
      { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "toolu_2" },
      undefined,
      "[平台] 插一句",
    );
    expect(JSON.parse(failed.stdout.trim()).hookSpecificOutput.hookEventName).toBe(
      "PostToolUseFailure",
    );
  }, 20_000);

  it("干活中途没有要插的：不写 stdout", async () => {
    const stdin = { hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "toolu_3" };
    const result = await runHook("", "PostToolUse", stdin);
    expect(result.requests).toEqual(["hook:tok", "inbox-midturn:tok"]);
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
