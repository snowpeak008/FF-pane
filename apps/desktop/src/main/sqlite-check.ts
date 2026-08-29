import Database from "better-sqlite3";
import type { SqliteCheckReport } from "../shared-ipc/contracts";

/**
 * 打开内存库执行一次真实查询，验证 better-sqlite3 原生模块能在当前 Electron 内加载
 * （开发计划 §12 风险 R1 的暴露点）。
 * better-sqlite3 13 以 Node-API 预编译二进制分发（prebuilds/<platform>-<arch>.node），
 * 与运行时 ABI 解耦，Node 与 Electron 共用同一二进制，无需 electron-rebuild。
 * 失败时抛出带修复提示的错误，由调用方决定呈现方式。
 */
export function runSqliteCheck(): SqliteCheckReport {
  let db: Database.Database | undefined;
  try {
    db = new Database(":memory:");
    const row = db.prepare("SELECT sqlite_version() AS version, 1 + 1 AS sum").get() as
      | { version: string; sum: number }
      | undefined;
    if (row === undefined || row.sum !== 2) {
      throw new Error(`SELECT 结果异常：${JSON.stringify(row)}`);
    }
    return { sqliteVersion: row.version, checkedAt: Date.now() };
  } catch (thrown) {
    const cause = thrown instanceof Error ? thrown.message : String(thrown);
    throw new Error(
      "better-sqlite3 加载或查询失败。请确认 node_modules/better-sqlite3/prebuilds 下存在" +
        `当前平台的 .node 文件，必要时重新安装依赖（pnpm install --force）。原始错误：${cause}`,
    );
  } finally {
    db?.close();
  }
}
