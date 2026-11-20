/**
 * 工作台 MCP sidecar 规格（T10.7a）。
 * 启动方式与知识库 sidecar 相同：Electron 以 ELECTRON_RUN_AS_NODE 执行同目录脚本。
 * 不依赖系统 node.exe（那是 hook 的路径；没有 node 时 hook 可以不装，工作台 MCP 不行）。
 * 不经 shell。令牌与管道名由 injectTokenIntoMcpServers 再接上，这里不写明文。
 */

import { join } from "node:path";
import process from "node:process";
import type { McpStdioServerSpec } from "@ff-pane/adapters";
import { FF_PANE_WINDOW_TOKEN_ENV, FF_PANE_WINDOW_TOKEN_ENV_PLACEHOLDER } from "@ff-pane/core";
import { WORKBENCH_MCP_SERVER_NAME } from "../../mcp/workbench-tools";

export const WORKBENCH_MCP_SCRIPT = "workbench-mcp.js";

export { WORKBENCH_MCP_SERVER_NAME };

/** 工作台工具在 CLI 侧的超时：比 ffpane_wait_events 的上限（540 秒）再多一分钟。 */
export const WORKBENCH_TOOL_TIMEOUT_SEC = 600;

export function buildWorkbenchMcpSpec(
  moduleDir: string,
  execPath = process.execPath,
): McpStdioServerSpec {
  return {
    command: execPath,
    args: [join(moduleDir, WORKBENCH_MCP_SCRIPT)],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    // ffpane_wait_events 最长挂 9 分钟，Codex 默认 60 秒会判超时。
    toolTimeoutSec: WORKBENCH_TOOL_TIMEOUT_SEC,
  };
}

/**
 * Claude `--mcp-config` 里的 HTTP 写法（T11.19）。令牌只写占位符，由 Claude 从进程环境展开。
 * `timeout`：Claude 走 HTTP 时 300 秒没有结果或进度就掐断；服务端每 15 秒发进度通知，
 * 这里再放宽到 600 秒兜底（请求没带 progressToken 时只能靠它）。
 */
export function buildWorkbenchClaudeHttpEntry(url: string): Readonly<Record<string, unknown>> {
  return {
    type: "http",
    url,
    headers: { Authorization: `Bearer ${FF_PANE_WINDOW_TOKEN_ENV_PLACEHOLDER}` },
    timeout: WORKBENCH_TOOL_TIMEOUT_SEC * 1000,
  };
}

/** Codex 的 HTTP 写法（T11.19）：`-c` 里只有地址和环境变量名，令牌值留在进程环境。 */
export function buildWorkbenchCodexHttpOverrides(url: string): Record<string, string> {
  const prefix = `mcp_servers.${WORKBENCH_MCP_SERVER_NAME}`;
  return {
    [`${prefix}.url`]: JSON.stringify(url),
    [`${prefix}.bearer_token_env_var`]: JSON.stringify(FF_PANE_WINDOW_TOKEN_ENV),
    [`${prefix}.tool_timeout_sec`]: String(WORKBENCH_TOOL_TIMEOUT_SEC),
  };
}
