/**
 * 索引库 schema 版本迁移框架(W1.3a)。
 * 版本记录在 SQLite 头部的 PRAGMA user_version(整数,随事务回滚),
 * 迁移函数按目标版本从 1 起连续递增排列,打开库时自动逐级升级。
 * 文件版本高于本进程已知最新版本时抛 IndexDbVersionError 拒绝打开——
 * 防止旧版本程序以旧 schema 认知写坏新版本库(新旧版本互踩)。
 * 索引是派生数据(设计文档 §8.4),迁移失败的兜底永远是删库重建,
 * 因此本框架只做前向升级,不做降级。
 */

import type Database from "better-sqlite3";

/** 单个版本化迁移:up 执行完毕后库结构即达到 toVersion。 */
export interface IndexDbMigration {
  /** 迁移完成后的 user_version。全表必须从 1 起连续递增。 */
  readonly toVersion: number;
  /** 一句话描述,进错误信息与日志。 */
  readonly description: string;
  /** 结构升级脚本。由框架包在事务里执行,无需自开事务。 */
  readonly up: (db: Database.Database) => void;
}

/** DB 文件的 user_version 高于本进程已知最新版本,拒绝打开。 */
export class IndexDbVersionError extends Error {
  /** 文件里的 user_version。 */
  readonly fileVersion: number;
  /** 本进程已知的最新版本。 */
  readonly latestKnownVersion: number;

  constructor(fileVersion: number, latestKnownVersion: number) {
    super(
      `索引库 user_version=${fileVersion} 高于本程序已知最新版本 ${latestKnownVersion},` +
        "拒绝打开(可能由更新版本的程序创建)。索引是派生数据,如确认无新版本程序在用,可删除该文件后重建。",
    );
    this.name = "IndexDbVersionError";
    this.fileVersion = fileVersion;
    this.latestKnownVersion = latestKnownVersion;
  }
}

/** 读取当前 user_version。 */
export function readUserVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

/**
 * 逐级执行缺失的迁移:每个迁移单独一个事务(up + 写 user_version 原子提交),
 * 中途失败时已完成的层级保留、失败层级整体回滚。
 * 返回迁移前后的版本号,便于调用方记录日志。
 */
export function runMigrations(
  db: Database.Database,
  migrations: readonly IndexDbMigration[],
): { readonly fromVersion: number; readonly toVersion: number } {
  migrations.forEach((migration, index) => {
    if (migration.toVersion !== index + 1) {
      throw new Error(
        `迁移表损坏:第 ${index} 项的 toVersion=${migration.toVersion},应为从 1 起连续递增的 ${index + 1}`,
      );
    }
  });

  const fromVersion = readUserVersion(db);
  const latestKnownVersion = migrations.length;
  if (fromVersion > latestKnownVersion) {
    throw new IndexDbVersionError(fromVersion, latestKnownVersion);
  }

  for (const migration of migrations.slice(fromVersion)) {
    db.transaction(() => {
      migration.up(db);
      // toVersion 已在上方校验为整数序列,插值安全(PRAGMA 不支持绑定参数)。
      db.pragma(`user_version = ${migration.toVersion}`);
    })();
  }

  return { fromVersion, toVersion: latestKnownVersion };
}
