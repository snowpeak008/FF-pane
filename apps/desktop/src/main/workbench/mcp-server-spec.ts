/**
 * 工作台 MCP sidecar 规格（T10.7a）。
 * 启动方式与知识库 sidecar 相同：Electron 以 ELECTRON_RUN_AS_NODE 执行同目录脚本。
 * 不依赖系统 node.exe（那是 hook 的路径；没有 node 时 hook 可以不装，工作台 MCP 不行）。
 * 不经 shell。令牌与管道名由 injectTokenIntoMcpServers 再接上，这里不写明文。
 */

import { join } from "node:path";
import process from "node:process";
import type { McpStdioServerSpec } from "@ff-pane/adapters";
import { WORKBENCH_MCP_SERVER_NAME } from "../../mcp/workbench-tools";

export const WORKBENCH_MCP_SCRIPT = "workbench-mcp.js";

export { WORKBENCH_MCP_SERVER_NAME };

export function buildWorkbenchMcpSpec(
  moduleDir: string,
  execPath = process.execPath,
): McpStdioServerSpec {
  return {
    command: execPath,
    args: [join(moduleDir, WORKBENCH_MCP_SCRIPT)],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}
