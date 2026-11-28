/**
 * agy 窗口里关于「ffpane 工具」的说明（计划 docs/用户内容可插拔与agy工具插件计划.md §2.3）。
 *
 * agy 的 agent 只有经插件自带的 MCP 服务器才拿得到 MCP 工具（2026-11-28 实测），而且 MCP 工具是
 * 懒加载的：先读描述文件、再用内置 `call_mcp_tool` 调。没添加插件时没有这些工具，agent 容易自己
 * 去翻 FF-pane 的 HTTP 地址和令牌去连，所以要明说别这么做。
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** 插件名_服务器名，agy 里叫它的名字（和 `agy-plugin.ts` 里的插件名、服务器名一致）。 */
export const AGY_PLUGIN_SERVER_REF = "ffpane-workbench_ffpane-workbench";

/**
 * @param installed true=插件已添加且可用；false=没有；undefined=没查出来（不写说明，免得说错）
 */
export function agyPluginNote(installed: boolean | undefined, home: string = homedir()): string {
  if (installed === undefined) {
    return "";
  }
  if (!installed) {
    return [
      "【ffpane 工具】这个窗口没有 ffpane 工具：用户没有在 FF-pane 设置里给 agy 添加 ffpane 工具插件。",
      "上面提到的 ffpane_* 工具你都调不了。不要自己去找 FF-pane 的 HTTP 地址或窗口令牌去连。",
      "用你自己的工具把任务做完；需要汇报时，直接在回复里写清楚结果。",
    ].join("\n");
  }
  const dir = join(home, ".gemini", "antigravity-cli", "mcp", AGY_PLUGIN_SERVER_REF);
  return [
    "【ffpane 工具】ffpane_* 工具在 agy 里是按需加载的 MCP 工具，这样调：",
    `1. 先读它的描述文件：${join(dir, "<工具名>.json")}（例如 ffpane_whoami.json），看参数。`,
    `2. 再用内置工具 call_mcp_tool：ServerName 填 ${AGY_PLUGIN_SERVER_REF}，ToolName 填工具名，Arguments 填 JSON 字符串。`,
    "不要自己去找 FF-pane 的 HTTP 地址或窗口令牌去连。",
  ].join("\n");
}

/** 把说明接在角色说明后面（没有说明就原样返回）。 */
export function withAgyPluginNote(instructions: string, note: string): string {
  return note === "" ? instructions : `${instructions}\n\n${note}`;
}
