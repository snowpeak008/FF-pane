/**
 * T8.2b 对话回放本 + 在飞轮次标记单测，全部走 mkdtemp 临时目录真实读写。
 * 覆盖：追加与读取往返、尾部截取、坏行跳过并计数、同一会话两轮交错追加不串行、
 * 标记写/删/列 + 部分文本覆盖写、坏标记进 issues 不阻断。
 */

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  InflightTurnMarker,
  LocalSessionId,
  ProfileId,
  TaskId,
  TranscriptEntry,
} from "@ff-pane/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendTranscriptEntry,
  deleteInflightMarker,
  listInflightMarkers,
  type ProjectLayout,
  readInflightPartial,
  readTranscript,
  resolveInflightPaths,
  resolveProjectLayout,
  resolveTranscriptPaths,
  writeInflightMarker,
  writeInflightPartial,
  writeJsonAtomic,
} from "../src/index.js";

let tempRoot: string;
let layout: ProjectLayout;
const SESSION = "sess-1" as LocalSessionId;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ff-pane-transcript-"));
  layout = resolveProjectLayout(tempRoot);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function userMessage(turnId: string, text: string, at = 1): TranscriptEntry {
  return { kind: "user_message", turnId, at, text };
}

function assistantMessage(turnId: string, text: string, at = 2): TranscriptEntry {
  return { kind: "assistant_message", turnId, at, text };
}

function turnEnd(turnId: string, at = 3): TranscriptEntry {
  return {
    kind: "turn_end",
    turnId,
    at,
    role: "planner",
    profileId: "prof-1" as ProfileId,
    endReason: "completed",
  };
}

describe("transcript.jsonl", () => {
  it("路径：sessions/<localSessionId>/transcript.jsonl，ID 经文件名安全化", () => {
    const paths = resolveTranscriptPaths(layout, "a/b:c" as LocalSessionId);
    expect(paths.sessionDir).toBe(join(layout.sessionsDir, "a%2Fb%3Ac"));
    expect(paths.transcriptFile).toBe(join(paths.sessionDir, "transcript.jsonl"));
  });

  it("未聊过的会话：文件不存在视为空回放本，不抛", async () => {
    expect(await readTranscript(layout, SESSION)).toEqual({ entries: [], skippedLines: 0 });
  });

  it("追加与读取往返：三类条目按写入顺序原样读回，一行一条、UTF-8 无 BOM", async () => {
    const entries: TranscriptEntry[] = [
      userMessage("t1", "第一问\n带换行"),
      assistantMessage("t1", "第一答"),
      turnEnd("t1"),
    ];
    for (const entry of entries) {
      await appendTranscriptEntry(layout, SESSION, entry);
    }
    const result = await readTranscript(layout, SESSION);
    expect(result.entries).toEqual(entries);
    expect(result.skippedLines).toBe(0);
    const raw = await readFile(resolveTranscriptPaths(layout, SESSION).transcriptFile);
    expect(raw[0]).not.toBe(0xef);
    expect(raw.toString("utf8").trimEnd().split("\n")).toHaveLength(3);
  });

  it("tail：只取末尾 N 条，末尾即最近", async () => {
    for (let i = 1; i <= 5; i += 1) {
      await appendTranscriptEntry(layout, SESSION, userMessage(`t${i}`, `第${i}问`, i));
    }
    const result = await readTranscript(layout, SESSION, { tail: 2 });
    expect(result.entries.map((e) => e.turnId)).toEqual(["t4", "t5"]);
    // tail 大于总数 = 全部
    expect((await readTranscript(layout, SESSION, { tail: 99 })).entries).toHaveLength(5);
  });

  it("坏行容错：非 JSON / 非对象 / 未知 kind / 字段非法一律跳过并计数，好行照常读回", async () => {
    await appendTranscriptEntry(layout, SESSION, userMessage("t1", "好的一条"));
    const { transcriptFile } = resolveTranscriptPaths(layout, SESSION);
    const badLines = [
      "{ not json",
      "[1,2,3]",
      JSON.stringify({ kind: "tool_event", turnId: "t1", at: 1 }),
      JSON.stringify({ kind: "user_message", turnId: "t1", at: "not-number", text: "x" }),
      JSON.stringify({
        kind: "turn_end",
        turnId: "t1",
        at: 1,
        role: "bogus",
        profileId: "p",
        endReason: "completed",
      }),
      JSON.stringify({
        kind: "turn_end",
        turnId: "t1",
        at: 1,
        role: "planner",
        profileId: "p",
        endReason: "exploded",
      }),
      JSON.stringify({ kind: "assistant_message", turnId: "t1", at: 1, text: "x", partial: false }),
    ];
    await writeFile(transcriptFile, `${badLines.join("\n")}\n`, { encoding: "utf8", flag: "a" });
    await appendTranscriptEntry(layout, SESSION, turnEnd("t1"));

    const result = await readTranscript(layout, SESSION);
    expect(result.skippedLines).toBe(badLines.length);
    expect(result.entries.map((e) => e.kind)).toEqual(["user_message", "turn_end"]);
    // tail 只截合法条目，坏行计数仍是整文件的
    const tailed = await readTranscript(layout, SESSION, { tail: 1 });
    expect(tailed.entries.map((e) => e.kind)).toEqual(["turn_end"]);
    expect(tailed.skippedLines).toBe(badLines.length);
  });

  it("同一会话两轮交错追加：每条整行落盘、条数不丢、不串行", async () => {
    const longText = "甲".repeat(20_000);
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 20; i += 1) {
      writes.push(
        appendTranscriptEntry(layout, SESSION, userMessage("turn-A", `${longText}A${i}`, i)),
      );
      writes.push(
        appendTranscriptEntry(layout, SESSION, assistantMessage("turn-B", `${longText}B${i}`, i)),
      );
    }
    await Promise.all(writes);

    const result = await readTranscript(layout, SESSION);
    expect(result.skippedLines).toBe(0);
    expect(result.entries).toHaveLength(40);
    const a = result.entries.filter((e) => e.turnId === "turn-A");
    const b = result.entries.filter((e) => e.turnId === "turn-B");
    expect(a).toHaveLength(20);
    expect(b).toHaveLength(20);
    // 每条的正文都完整（末尾序号可解出且与 at 一致）
    for (const entry of result.entries) {
      if (entry.kind === "turn_end") {
        continue;
      }
      expect(entry.text.startsWith(longText)).toBe(true);
      expect(Number(entry.text.slice(longText.length + 1))).toBe(entry.at);
    }
  });
});

describe("inflight 标记与部分文本", () => {
  function marker(overrides: Partial<InflightTurnMarker> = {}): InflightTurnMarker {
    return {
      turnId: "turn-1",
      sessionId: SESSION,
      role: "worker",
      profileId: "prof-1" as ProfileId,
      startedAt: 1000,
      taskId: "task-1" as TaskId,
      ...overrides,
    };
  }

  it("路径：inflight/<turnId>.json 与 <turnId>.partial.txt，turnId 经安全化", () => {
    const paths = resolveInflightPaths(layout, "t:1");
    expect(paths.markerFile).toBe(join(layout.sessionsInflightDir, "t%3A1.json"));
    expect(paths.partialFile).toBe(join(layout.sessionsInflightDir, "t%3A1.partial.txt"));
  });

  it("从未跑过轮次：inflight/ 不存在视为空集", async () => {
    expect(await listInflightMarkers(layout)).toEqual({ markers: [], issues: [] });
    expect(await readInflightPartial(layout, "nope")).toBeUndefined();
    expect(await deleteInflightMarker(layout, "nope")).toBe(false);
  });

  it("写 / 列 / 删 往返：列表按文件名排序，删除连带部分文本并返回此前是否存在", async () => {
    await writeInflightMarker(layout, marker({ turnId: "turn-b" }));
    await writeInflightMarker(
      layout,
      marker({ turnId: "turn-a", role: "planner", taskId: undefined }),
    );
    await writeInflightPartial(layout, "turn-b", "部分文本");

    const listing = await listInflightMarkers(layout);
    expect(listing.issues).toEqual([]);
    expect(listing.markers.map((m) => m.turnId)).toEqual(["turn-a", "turn-b"]);
    expect(listing.markers[0]).not.toHaveProperty("taskId");
    expect(await readInflightPartial(layout, "turn-b")).toBe("部分文本");

    expect(await deleteInflightMarker(layout, "turn-b")).toBe(true);
    expect(await readInflightPartial(layout, "turn-b")).toBeUndefined();
    expect((await listInflightMarkers(layout)).markers.map((m) => m.turnId)).toEqual(["turn-a"]);
    // 目录里不残留 turn-b 的任何文件
    expect((await readdir(layout.sessionsInflightDir)).filter((n) => n.includes("turn-b"))).toEqual(
      [],
    );
    expect(await deleteInflightMarker(layout, "turn-b")).toBe(false);
  });

  it("部分文本覆盖写：后写覆盖前写，不追加", async () => {
    await writeInflightPartial(layout, "turn-1", "第一版很长很长很长");
    await writeInflightPartial(layout, "turn-1", "第二版");
    expect(await readInflightPartial(layout, "turn-1")).toBe("第二版");
    const { partialFile } = resolveInflightPaths(layout, "turn-1");
    expect((await stat(partialFile)).isFile()).toBe(true);
  });

  it("坏标记（字段非法）进 issues，不阻断其余标记；partial 文件不被误当标记", async () => {
    await writeInflightMarker(layout, marker({ turnId: "good" }));
    await writeInflightPartial(layout, "good", "x");
    await writeJsonAtomic(resolveInflightPaths(layout, "bad").markerFile, {
      turnId: "bad",
      sessionId: SESSION,
      role: "nobody",
      profileId: "p",
      startedAt: 1,
    });
    const listing = await listInflightMarkers(layout);
    expect(listing.markers.map((m) => m.turnId)).toEqual(["good"]);
    expect(listing.issues).toHaveLength(1);
    expect(listing.issues[0]?.path).toBe(resolveInflightPaths(layout, "bad").markerFile);
  });
});
