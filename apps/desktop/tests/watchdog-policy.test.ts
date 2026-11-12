/**
 * T11.12 主线程看门狗与「再双击认出卡死的上一份」的判断规则。
 */

import { describe, expect, it } from "vitest";
import {
  describeSilence,
  isInstanceStale,
  logFileNameFor,
  parseInstanceInfo,
  STALE_INSTANCE_MS,
  staleCrashReports,
} from "../src/main/diagnostics/policy";
import {
  decideWatchdogTick,
  noteBeat,
  noteClosing,
  type WatchdogLimits,
  watchdogLogFileName,
} from "../src/main/diagnostics/watchdog-policy";

const limits: WatchdogLimits = {
  frozenLogMs: 60_000,
  closingFrozenKillMs: 10_000,
  closingMaxMs: 20_000,
};

describe("看门狗：平时", () => {
  it("有心跳时什么都不做", () => {
    const decided = decideWatchdogTick({ lastBeat: 1_000 }, 3_000, limits);
    expect(decided.action).toEqual({ kind: "none" });
  });

  it("平时卡住不杀，60 秒记一行，之后每 60 秒再记一行", () => {
    let state = { lastBeat: 0 } as Parameters<typeof decideWatchdogTick>[0];
    let decided = decideWatchdogTick(state, 59_000, limits);
    expect(decided.action.kind).toBe("none");
    decided = decideWatchdogTick(state, 60_000, limits);
    expect(decided.action).toEqual({ kind: "log-frozen", silentMs: 60_000 });
    state = decided.state;
    expect(decideWatchdogTick(state, 100_000, limits).action.kind).toBe("none");
    decided = decideWatchdogTick(state, 120_000, limits);
    expect(decided.action).toEqual({ kind: "log-frozen", silentMs: 120_000 });
    // 卡多久都不杀
    expect(decideWatchdogTick(decided.state, 3_600_000, limits).action.kind).not.toBe("kill");
  });

  it("记过「冻住」后恢复心跳，报冻了多久，并清掉记录", () => {
    const frozen = decideWatchdogTick({ lastBeat: 0 }, 60_000, limits).state;
    const beat = noteBeat(frozen, 75_000);
    expect(beat.recoveredAfterMs).toBe(75_000);
    expect(beat.state).toEqual({ lastBeat: 75_000 });
    expect(noteBeat(beat.state, 77_000).recoveredAfterMs).toBeUndefined();
  });
});

describe("看门狗：关窗、退出过程中", () => {
  it("10 秒没心跳就强退", () => {
    const state = noteClosing({ lastBeat: 0 }, 1_000);
    expect(decideWatchdogTick(state, 9_999, limits).action.kind).toBe("none");
    expect(decideWatchdogTick(state, 10_000, limits).action).toEqual({
      kind: "kill",
      reason: "closing-frozen",
      silentMs: 10_000,
    });
  });

  it("一直有心跳，但开始关窗 20 秒了还没退掉，也强退", () => {
    let state = noteClosing({ lastBeat: 0 }, 0);
    for (let at = 2_000; at < 20_000; at += 2_000) {
      state = noteBeat(state, at).state;
      expect(decideWatchdogTick(state, at, limits).action.kind).toBe("none");
    }
    state = noteBeat(state, 20_000).state;
    expect(decideWatchdogTick(state, 20_000, limits).action).toMatchObject({
      kind: "kill",
      reason: "closing-too-long",
    });
  });

  it("重复收到关窗不重新计时，心跳也不清掉关窗状态", () => {
    const first = noteClosing({ lastBeat: 0 }, 1_000);
    expect(noteClosing(first, 5_000).closingSince).toBe(1_000);
    expect(noteBeat(first, 6_000).state.closingSince).toBe(1_000);
  });
});

describe("instance.json", () => {
  it("读得懂的记录", () => {
    expect(parseInstanceInfo('{"pid":34448,"startedAt":1,"lastBeat":2}')).toEqual({
      pid: 34448,
      startedAt: 1,
      lastBeat: 2,
    });
  });

  it.each([
    "",
    "{",
    "null",
    "[]",
    '{"pid":"34448","startedAt":1,"lastBeat":2}',
    '{"pid":0,"startedAt":1,"lastBeat":2}',
    '{"pid":1.5,"startedAt":1,"lastBeat":2}',
    '{"pid":1,"startedAt":1}',
  ])("读不懂的当没有：%s", (text) => {
    expect(parseInstanceInfo(text)).toBeUndefined();
  });

  it("心跳停了 30 秒才算卡死", () => {
    const info = { pid: 1, startedAt: 0, lastBeat: 100_000 };
    expect(isInstanceStale(info, 100_000 + STALE_INSTANCE_MS - 1)).toBe(false);
    expect(isInstanceStale(info, 100_000 + STALE_INSTANCE_MS)).toBe(true);
  });

  it("弹框里的时长", () => {
    expect(describeSilence(31_000)).toBe("31 秒");
    expect(describeSilence(59_400)).toBe("59 秒");
    expect(describeSilence(60_000)).toBe("1 分钟");
    expect(describeSilence(7 * 60_000 + 20_000)).toBe("7 分钟");
  });
});

describe("看门狗日志文件名", () => {
  it("和主进程日志是同一个文件", () => {
    for (const date of [new Date(2026, 0, 1, 0, 0), new Date(2026, 10, 12, 23, 59)]) {
      expect(watchdogLogFileName(date)).toBe(logFileNameFor(date));
    }
  });
});

describe("旧崩溃记录", () => {
  const day = 86_400_000;
  const now = 100 * day;

  it("只留最近 5 份，超过 14 天的也删，不认识的文件不动", () => {
    const entries = [
      ...Array.from({ length: 7 }, (_, i) => ({ name: `r${i}.dmp`, mtimeMs: now - i * day })),
      { name: "old.DMP", mtimeMs: now - 20 * day },
      { name: "settings.dat", mtimeMs: now - 90 * day },
    ];
    expect([...staleCrashReports(entries, now)].sort()).toEqual(["old.DMP", "r5.dmp", "r6.dmp"]);
  });

  it("不到 5 份时只按天数删", () => {
    const entries = [
      { name: "a.dmp", mtimeMs: now - 13 * day },
      { name: "b.dmp", mtimeMs: now - 14 * day },
    ];
    expect(staleCrashReports(entries, now)).toEqual(["b.dmp"]);
  });
});
