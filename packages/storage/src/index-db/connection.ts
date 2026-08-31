/**
 * 索引库连接基座(W1.3a):open/close 封装。
 * better-sqlite3 同步 API,仅供主进程使用(技术选型 §5)。
 * 索引永远是派生数据(设计文档 §8.4):打开失败/版本异常的兜底是删除 DB 文件重建。
 */

import Database from "better-sqlite3";
import { runMigrations } from "./migrations.js";
import { INDEX_DB_MIGRATIONS } from "./schema.js";

/** busy_timeout 缺省值(毫秒):遇 SQLITE_BUSY 时自旋等待的上限。 */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** openIndexDb 的参数。 */
export interface OpenIndexDbOptions {
  /**
   * DB 文件路径,由调用方注入(目录布局归 W1.2a/W1.3b,本层不做路径决策,
   * 父目录须已存在)。传 ":memory:" 得到进程内临时库(测试用,WAL 不适用)。
   */
  readonly filePath: string;
  /** 覆盖 busy_timeout(毫秒),缺省 DEFAULT_BUSY_TIMEOUT_MS。 */
  readonly busyTimeoutMs?: number;
  /**
   * 以只读方式打开(缺省 false)。
   *
   * 用于 T6.6 的 MCP 检索 sidecar:它由 CLI Agent 拉起、与主进程并存,只该查不该写。
   * 只读不只是"我们不调用写方法"的自律,而是让 SQLite 在连接层面拒绝一切写入——
   * 只读连接上跑 INSERT 会被数据库直接拒掉,不依赖调用方守规矩。
   *
   * 只读模式下**不建库、不迁移、不设写相关 pragma**:journal_mode / synchronous
   * 都要写库文件,在只读连接上会直接报错。库的建立与迁移始终是主进程的事。
   *
   * 注意:读一个 WAL 库需要能访问 -shm/-wal 旁文件。sidecar 只在会话进行中被拉起,
   * 那时主进程正持有该库,旁文件必然存在,故这条前提在真实调用路径上恒成立。
   */
  readonly readonly?: boolean;
}

/**
 * 打开(必要时创建)索引库:启用 WAL、设置 busy_timeout,并自动逐级执行
 * schema 迁移。文件版本高于本程序已知版本时抛 IndexDbVersionError 拒开。
 * `readonly: true` 时只开连接、不建不迁(见该选项注释)。
 */
export function openIndexDb(options: OpenIndexDbOptions): Database.Database {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new RangeError(`busyTimeoutMs 须为非负整数,收到 ${busyTimeoutMs}`);
  }

  const isReadonly = options.readonly === true;
  // readonly 连接天然要求文件已存在(better-sqlite3 对只读连接忽略 fileMustExist,
  // 库不存在即抛 SQLITE_CANTOPEN),故"知识库还没建过"会表现为一个明确的打开失败,
  // 而不是悄悄建出一个空库、让检索永远返回零命中。
  const db = new Database(options.filePath, isReadonly ? { readonly: true } : {});
  try {
    if (!isReadonly) {
      // WAL:读写不互斥,且主进程单写者场景下崩溃恢复语义最简单(内存库自动忽略)。
      db.pragma("journal_mode = WAL");
      // WAL 下 NORMAL 已保证库一致性,只在断电场景可能丢最近事务——索引可重建,可接受。
      db.pragma("synchronous = NORMAL");
    }
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    // 外键约束（SQLite 默认关闭）：知识库索引（v2）靠 ON DELETE CASCADE 保证
    // 删条目即连带删块与标签。v1 的记忆表不含外键，开启对它无影响。
    // 注：vec0 是虚表，CASCADE 管不到，向量删除由 knowledge-index 显式处理。
    // 只读连接上它是无害的空操作(没有写入可级联),照设不影响。
    db.pragma("foreign_keys = ON");
    if (!isReadonly) {
      runMigrations(db, INDEX_DB_MIGRATIONS);
    }
    return db;
  } catch (thrown) {
    db.close();
    throw thrown;
  }
}

/** 关闭索引库。幂等:重复关闭不报错。 */
export function closeIndexDb(db: Database.Database): void {
  if (db.open) {
    db.close();
  }
}
