/**
 * 全局数据根解析（单一事实来源）。
 *
 * 默认 `<homedir>/.aiworkbench`；`FF_PANE_DATA_ROOT` 环境变量可覆盖，供 E2E 隔离到临时目录
 * （不污染真实用户目录）与可移植部署使用。data 层与 session 层**必须**共用此解析，
 * 否则二者落到不同根、彼此看不到对方写入的 Provider/Profile（实测坑）。
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { GLOBAL_ROOT_DIR_NAME } from "@ff-pane/storage";

/** 解析全局数据根（FF_PANE_DATA_ROOT 覆盖优先，否则 <homedir>/.aiworkbench）。 */
export function resolveGlobalRoot(): string {
  const override = process.env["FF_PANE_DATA_ROOT"];
  return override !== undefined && override.length > 0
    ? resolve(override)
    : join(homedir(), GLOBAL_ROOT_DIR_NAME);
}
