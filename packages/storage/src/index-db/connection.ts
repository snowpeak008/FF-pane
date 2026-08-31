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
}

/**
 * 打开(必要时创建)索引库:启用 WAL、设置 busy_timeout,并自动逐级执行
 * schema 迁移。文件版本高于本程序已知版本时抛 IndexDbVersionError 拒开。
 */
export function openIndexDb(options: OpenIndexDbOptions): Database.Database {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new RangeError(`busyTimeoutMs 须为非负整数,收到 ${busyTimeoutMs}`);
  }

  const db = new Database(options.filePath);
  try {
    // WAL:读写不互斥,且主进程单写者场景下崩溃恢复语义最简单(内存库自动忽略)。
    db.pragma("journal_mode = WAL");
    // WAL 下 NORMAL 已保证库一致性,只在断电场景可能丢最近事务——索引可重建,可接受。
    db.pragma("synchronous = NORMAL");
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    // 外键约束（SQLite 默认关闭）：知识库索引（v2）靠 ON DELETE CASCADE 保证
    // 删条目即连带删块与标签。v1 的记忆表不含外键，开启对它无影响。
    // 注：vec0 是虚表，CASCADE 管不到，向量删除由 knowledge-index 显式处理。
    db.pragma("foreign_keys = ON");
    runMigrations(db, INDEX_DB_MIGRATIONS);
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
