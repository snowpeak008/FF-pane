/**
 * 每轮 MCP 配置文件的落盘与清理（T6.6）。
 *
 * Claude Code 经 `--mcp-config <path>` 接受一份 `{ "mcpServers": {...} }` 的 JSON。
 * 三条约束，与 gemini 的 policy-file 同一套纪律：
 *
 * 1. **写系统临时目录、用完即删，绝不改用户的 `~/.claude.json`**。注入是本轮的事，
 *    不该在用户的持久配置里留下任何痕迹——用户在别处跑 claude 时的 MCP 关联必须
 *    与从未装过本产品时一模一样。
 * 2. **逐轮一份独立文件**（mkdtemp 保证目录唯一）。多轮并发时共用一份文件会互相
 *    覆盖，且清理时会删掉别的轮次正在用的配置。
 * 3. **同步创建**：AgentAdapter.startTurn 必须同步返回句柄，配置文件是启动参数的
 *    一部分，等不了异步 IO。文件仅数百字节，同步写无实际开销。
 */

/// <reference types="node" />

import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpStdioServerSpec } from "../adapter.js";

/** 临时目录前缀（排障时按此前缀可在 %TEMP% 里定位残留）。 */
export const CLAUDE_MCP_DIR_PREFIX = "ff-pane-claude-mcp-";

/** 配置文件名。 */
export const CLAUDE_MCP_FILE_NAME = "ff-pane-mcp.json";

/** 配置文件装配失败（属装配错误，由适配器转为 end(failed) 上交）。 */
export class ClaudeMcpFileError extends Error {
  override readonly name = "ClaudeMcpFileError";
}

/** 已落盘的 MCP 配置文件句柄。 */
export interface ClaudeMcpFile {
  /** 传给 `--mcp-config` 的文件绝对路径。 */
  readonly path: string;
  /** 删除文件与其临时目录；幂等，失败静默（临时目录残留不该拖垮一轮任务）。 */
  remove(): Promise<void>;
}

/** 落盘选项。 */
export interface ClaudeMcpFileOptions {
  /** 临时目录父目录，默认 os.tmpdir()（测试可注入）。 */
  readonly dir?: string;
  /** 保留文件不删（仅排障用；默认 false = 用完即删）。 */
  readonly keep?: boolean;
}

/**
 * 把服务端表编译成 Claude Code 的 `--mcp-config` 文件内容。
 * 纯函数，便于单测比对（形状错了 claude 只会静默不加载该服务器）。
 */
export function buildClaudeMcpConfig(
  servers: Readonly<Record<string, McpStdioServerSpec>>,
): string {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(servers)) {
    mcpServers[name] = {
      // type 显式写 stdio：新版 claude 的配置支持 http/sse，缺省虽为 stdio，
      // 但写明才不至于随将来的默认值变化而漂移。
      type: "stdio",
      command: spec.command,
      args: [...(spec.args ?? [])],
      ...(spec.env !== undefined && Object.keys(spec.env).length > 0 ? { env: spec.env } : {}),
    };
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

/** 写入 MCP 配置文件。 */
export function writeClaudeMcpFile(
  servers: Readonly<Record<string, McpStdioServerSpec>>,
  options: ClaudeMcpFileOptions = {},
): ClaudeMcpFile {
  let directory: string;
  try {
    directory = mkdtempSync(join(options.dir ?? tmpdir(), CLAUDE_MCP_DIR_PREFIX));
  } catch (error) {
    throw new ClaudeMcpFileError(
      `无法在临时目录创建 Claude MCP 配置目录：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const path = join(directory, CLAUDE_MCP_FILE_NAME);
  try {
    writeFileSync(path, buildClaudeMcpConfig(servers), "utf8");
  } catch (error) {
    throw new ClaudeMcpFileError(
      `无法写入 Claude MCP 配置文件：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let removed = false;
  return {
    path,
    remove: async (): Promise<void> => {
      if (removed || options.keep === true) {
        return;
      }
      removed = true;
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/**
 * MCP 工具在 Claude 的 `--allowedTools` 里的名字：`mcp__<服务器名>__<工具名>`。
 *
 * 必须显式放行：本产品给 claude 传的是受管的权限模式，未放行的工具会走审批通道
 * 或被拒——而这个工具是只读检索，每次都弹一次审批纯属噪声。
 */
export function claudeMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}
