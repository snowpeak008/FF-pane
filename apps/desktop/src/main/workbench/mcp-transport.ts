/**
 * 工作台 MCP 每种运行时用哪种接法（T11.19 第二部分）。
 *
 * - http：连主进程里共用的一个 HTTP 服务（`mcp-http.ts`），不再每个窗口开一个 electron 小进程；
 * - stdio：老办法，每个窗口一个 `workbench-mcp.js` 小进程，经控制通道转发。
 *
 * 某种 CLI 实测不行，就在这张表里退回 stdio，别处不用改。
 * 开发和排查时设环境变量 FF_PANE_MCP_TRANSPORT=stdio，全部退回老办法。
 *
 * 2026-11-20 调研（计划 §3.4），Tony 当天定：
 *
 * | 运行时 | 接法 | HTTP 配置写法 | 实测 |
 * |---|---|---|---|
 * | Claude Code 2.1.302 | http | `--mcp-config`：`{"type":"http","url",headers.Authorization:"Bearer ${FF_PANE_WINDOW_TOKEN}","timeout":600000}` | 真调工具、挂满 9 分钟都测过 |
 * | Codex 0.166 | http | `-c mcp_servers.<名>.url`、`bearer_token_env_var="FF_PANE_WINDOW_TOKEN"`、`tool_timeout_sec=600` | 真调工具、挂满 9 分钟都测过 |
 * | Cursor CLI 2026.11.05 | stdio | 插件 mcp.json：`url`、`headers.Authorization:"Bearer ${env:FF_PANE_WINDOW_TOKEN}"` | 已确认能连上、能列出工具，令牌能从环境变量传；没测真正调工具和 9 分钟等待；没有账号，等以后补测再切 |
 * | Grok 1.0.62 | stdio | `.grok/config.toml`：`[mcp_servers.<名>]` 下 `url`，`[mcp_servers.<名>.headers]` 下 `Authorization = "Bearer ${FF_PANE_WINDOW_TOKEN}"` | 同 Cursor：已确认能连上、能列出工具，令牌能从环境变量传；没测真正调工具和 9 分钟等待；没有账号，等以后补测再切 |
 *
 * Cursor、Grok 的 HTTP 写法还没写进代码；切的时候补上配置生成，再把这里改成 http。
 */

export type WorkbenchMcpTransport = "http" | "stdio";

export type WorkbenchMcpRuntime = "claude-code" | "codex" | "grok" | "cursor" | "agy";

export const FF_PANE_MCP_TRANSPORT_ENV = "FF_PANE_MCP_TRANSPORT";

export const WORKBENCH_MCP_TRANSPORT_BY_RUNTIME: Readonly<
  Record<WorkbenchMcpRuntime, WorkbenchMcpTransport>
> = {
  "claude-code": "http",
  codex: "http",
  grok: "stdio",
  cursor: "stdio",
  // agy 1.5.18 的远程 MCP 只认 Streamable HTTP（`serverUrl`/`url` + `headers`），
  // 工作台的 HTTP 配置写法还没验证，先走 stdio 小进程。
  agy: "stdio",
};

/** 只有 Claude、Codex 有 HTTP 的配置写法；其余表里改成 http 也照旧走 stdio。 */
const HTTP_CAPABLE: ReadonlySet<WorkbenchMcpRuntime> = new Set(["claude-code", "codex"]);

export function workbenchMcpTransportFor(
  runtime: WorkbenchMcpRuntime,
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkbenchMcpTransport {
  if ((env[FF_PANE_MCP_TRANSPORT_ENV] ?? "").trim().toLowerCase() === "stdio") {
    return "stdio";
  }
  const wanted = WORKBENCH_MCP_TRANSPORT_BY_RUNTIME[runtime];
  return wanted === "http" && HTTP_CAPABLE.has(runtime) ? "http" : "stdio";
}
