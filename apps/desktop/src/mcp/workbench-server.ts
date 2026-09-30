/**
 * 工作台 MCP sidecar（T10.7a）。
 * 手写 stdio JSON-RPC，协议层复用 protocol.ts。
 * 启动时读取 FF_PANE_WINDOW_TOKEN 与 FF_PANE_WB_PIPE。
 * 令牌缺失或仍是字面量 ${FF_PANE_WINDOW_TOKEN} 时，每次工具调用都返回明确错误。
 * 工具本身转发到主进程控制通道，本进程不做授权判断。
 */

import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { FF_PANE_WB_PIPE_ENV, FF_PANE_WINDOW_TOKEN_ENV } from "@ff-pane/core";
import { handleMcpLine, type McpServerOptions, type McpToolResult } from "./protocol";
import { WORKBENCH_MCP_SERVER_NAME, WORKBENCH_MCP_TOOLS } from "./workbench-tools";

const SERVER_VERSION = "1.0.0";
const CALL_TIMEOUT_MS = 20_000;

export const WINDOW_TOKEN_LITERAL = `\${${FF_PANE_WINDOW_TOKEN_ENV}}`;
export const PIPE_LITERAL = `\${${FF_PANE_WB_PIPE_ENV}}`;

export function workbenchCredentialError(env: NodeJS.ProcessEnv): string | undefined {
  const token = env[FF_PANE_WINDOW_TOKEN_ENV] ?? "";
  const pipe = env[FF_PANE_WB_PIPE_ENV] ?? "";
  if (token.length === 0 || token === WINDOW_TOKEN_LITERAL) {
    return `窗口令牌未展开（空值或字面量 ${"$"}{FF_PANE_WINDOW_TOKEN}）。请重启该窗口；若重启后仍如此，说明当前 CLI 版本不会展开 MCP 环境变量。`;
  }
  if (pipe.length === 0 || pipe === PIPE_LITERAL) {
    return `控制通道未展开（空值或字面量 ${"$"}{FF_PANE_WB_PIPE}）。请重启该窗口；若重启后仍如此，说明当前 CLI 版本不会展开 MCP 环境变量。`;
  }
  return undefined;
}

export function callControlTool(
  pipePath: string,
  token: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<McpToolResult> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const finish = (result: McpToolResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const socket = createConnection(pipePath);
    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => {
      finish({ text: "控制通道超时。请稍后重试。", isError: true });
    });
    socket.on("error", () => {
      finish({ text: "控制通道断开，工具没有执行。请重启该窗口后再试。", isError: true });
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = buffer.slice(0, newline).trim();
      try {
        const parsed = JSON.parse(line) as {
          readonly ok?: unknown;
          readonly result?: { readonly text?: unknown; readonly isError?: unknown };
        };
        if (parsed.ok !== true) {
          finish({ text: "控制通道拒绝了这次工具调用。", isError: true });
          return;
        }
        const text = typeof parsed.result?.text === "string" ? parsed.result.text : "";
        finish({
          text: text.length > 0 ? text : "工具没有返回内容。",
          ...(parsed.result?.isError === true ? { isError: true } : {}),
        });
      } catch {
        finish({ text: "控制通道返回了无法解析的内容。", isError: true });
      }
    });
    socket.on("connect", () => {
      const line = `${JSON.stringify({
        v: 1,
        type: "tool",
        token,
        name,
        arguments: args,
      })}\n`;
      socket.write(line);
    });
  });
}

export function createWorkbenchMcpOptions(
  env: NodeJS.ProcessEnv,
  invoke: (name: string, args: Readonly<Record<string, unknown>>) => Promise<McpToolResult> = (
    name,
    args,
  ) => {
    const pipe = env[FF_PANE_WB_PIPE_ENV] ?? "";
    const token = env[FF_PANE_WINDOW_TOKEN_ENV] ?? "";
    return callControlTool(pipe, token, name, args);
  },
): McpServerOptions {
  const credentialError = workbenchCredentialError(env);
  return {
    name: WORKBENCH_MCP_SERVER_NAME,
    version: SERVER_VERSION,
    tools: WORKBENCH_MCP_TOOLS,
    execute: async (name, args) => {
      if (credentialError !== undefined) {
        return { text: credentialError, isError: true };
      }
      try {
        return await invoke(name, args);
      } catch {
        return { text: "控制通道断开，工具没有执行。请重启该窗口后再试。", isError: true };
      }
    },
  };
}

function invokedDirectly(): boolean {
  const entry = (process.argv[1] ?? "").replaceAll("\\", "/");
  return (
    entry.endsWith("/workbench-mcp.js") ||
    entry.endsWith("/workbench-mcp.ts") ||
    entry.endsWith("/workbench-server.js") ||
    entry.endsWith("/workbench-server.ts")
  );
}

function main(): void {
  const options = createWorkbenchMcpOptions(process.env);
  const rl = createInterface({ input: process.stdin });
  let queue: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    queue = queue.then(async () => {
      const response = await handleMcpLine(line, options);
      if (response !== null) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    });
  });
  rl.on("close", () => {
    void queue.finally(() => {
      process.exit(0);
    });
  });
}

if (invokedDirectly()) {
  main();
}
