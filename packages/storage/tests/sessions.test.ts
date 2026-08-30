/**
 * T4.3 会话登记表单测：Local↔Native Session ID 映射的持久化与 CRUD，
 * 全部走 mkdtemp 临时目录真实读写。覆盖：首次使用空集、upsert（新增/替换）、
 * 按 lastActiveAt 降序、删除命中/未命中、结构非法与字段非法的 typed error、
 * W1.2a 损坏隔离语义的向上传递。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalSessionId, NativeSessionId, ProfileId, SessionRecord } from "@ff-pane/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSessionStore,
  resolveProjectLayout,
  SESSIONS_FILE_VERSION,
  type SessionStore,
  SessionsFileInvalidError,
  StorageCorruptJsonError,
  writeJsonAtomic,
  writeTextAtomic,
} from "../src/index.js";

let tempRoot: string;
let sessionsFile: string;
let store: SessionStore;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ff-pane-sessions-"));
  sessionsFile = resolveProjectLayout(tempRoot).sessionsFile;
  store = createSessionStore(sessionsFile);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "sess-1" as LocalSessionId,
    profileId: "prof-1" as ProfileId,
    role: "planner",
    createdAt: 1000,
    lastActiveAt: 1000,
    ...overrides,
  };
}

describe("createSessionStore", () => {
  it("首次使用：文件不存在视为空集", async () => {
    expect(await store.listSessions()).toEqual([]);
    expect(await store.getSession("sess-x" as LocalSessionId)).toBeUndefined();
    expect(await store.deleteSession("sess-x" as LocalSessionId)).toBe(false);
  });

  it("saveSession 新增后可读回（round-trip），落盘带版本字段", async () => {
    const rec = record({
      native: { nativeSessionId: "native-abc" as NativeSessionId, cwd: tempRoot },
      resumeKind: "native",
    });
    await store.saveSession(rec);
    expect(await store.getSession(rec.id)).toEqual(rec);
    const text = await readFile(sessionsFile, "utf8");
    expect(JSON.parse(text).version).toBe(SESSIONS_FILE_VERSION);
  });

  it("saveSession 同 id 再存 = 整条替换（upsert）", async () => {
    await store.saveSession(record());
    await store.saveSession(record({ lastActiveAt: 2000, resumeKind: "context_rebuild" }));
    const all = await store.listSessions();
    expect(all).toHaveLength(1);
    expect(all[0]?.lastActiveAt).toBe(2000);
    expect(all[0]?.resumeKind).toBe("context_rebuild");
  });

  it("listSessions 按 lastActiveAt 降序（最近活跃在前）", async () => {
    await store.saveSession(record({ id: "a" as LocalSessionId, lastActiveAt: 100 }));
    await store.saveSession(record({ id: "b" as LocalSessionId, lastActiveAt: 300 }));
    await store.saveSession(record({ id: "c" as LocalSessionId, lastActiveAt: 200 }));
    expect((await store.listSessions()).map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("deleteSession 命中返回 true 并移除；未命中返回 false", async () => {
    await store.saveSession(record());
    expect(await store.deleteSession("sess-1" as LocalSessionId)).toBe(true);
    expect(await store.listSessions()).toEqual([]);
    expect(await store.deleteSession("sess-1" as LocalSessionId)).toBe(false);
  });

  it("结构非法（version 不支持）抛 SessionsFileInvalidError", async () => {
    await writeJsonAtomic(sessionsFile, { version: 99, sessions: [] });
    await expect(store.listSessions()).rejects.toBeInstanceOf(SessionsFileInvalidError);
  });

  it("条目字段非法（role 非法）抛 SessionsFileInvalidError", async () => {
    await writeJsonAtomic(sessionsFile, {
      version: SESSIONS_FILE_VERSION,
      sessions: [{ ...record(), role: "bogus" }],
    });
    await expect(store.listSessions()).rejects.toBeInstanceOf(SessionsFileInvalidError);
  });

  it("JSON 语法损坏：W1.2a 隔离 + 上抛 StorageCorruptJsonError，之后回到空集", async () => {
    await writeTextAtomic(sessionsFile, "{ not json ");
    await expect(store.listSessions()).rejects.toBeInstanceOf(StorageCorruptJsonError);
    // 隔离后原路径已被腾空，再次读取回到干净空集
    expect(await store.listSessions()).toEqual([]);
  });
});
