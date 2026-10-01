/**
 * Codex 会话认领单测：假 sessions 目录 + 时区日目录 + 隔离守卫。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertTestCodexHomeIsolated,
  CodexSessionClaimer,
  type CodexSessionMeta,
  collectCodexSessionScanDayDirs,
  cwdEquals,
  type DayParts,
  formatDayDir,
  isAutomatedTestEnv,
  isRealUserCodexPath,
  parseCodexRolloutSessionMeta,
  pickCodexSessionForClaim,
  readFileFirstLine,
  shiftDayParts,
  utcDayParts,
} from "../src/main/workbench/codex-claim";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "ffpane-codex-home-"));
  temps.push(dir);
  return dir;
}

/** 用固定偏移模拟某时区的本地日历（不改进程 TZ）。 */
function offsetLocalParts(offsetHours: number): (atMs: number) => DayParts {
  return (atMs: number) => {
    const shifted = new Date(atMs + offsetHours * 3_600_000);
    return {
      y: shifted.getUTCFullYear(),
      m: shifted.getUTCMonth() + 1,
      d: shifted.getUTCDate(),
    };
  };
}

function writeRollout(
  home: string,
  opts: {
    readonly id: string;
    readonly cwd: string;
    readonly timestampMs: number;
    /** 显式日目录（模拟 Codex 本地日）；缺省用 UTC 日。 */
    readonly dayPath?: string;
    readonly corrupt?: boolean;
    /** 写进文件前缀的认领记号（UUID）。 */
    readonly marker?: string;
  },
): string {
  const timestamp = new Date(opts.timestampMs).toISOString();
  const day =
    opts.dayPath ??
    formatDayDir({
      y: new Date(opts.timestampMs).getUTCFullYear(),
      m: new Date(opts.timestampMs).getUTCMonth() + 1,
      d: new Date(opts.timestampMs).getUTCDate(),
    });
  const dir = join(home, "sessions", ...day.split("/"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${timestamp.replace(/[:.]/g, "-")}-${opts.id}.jsonl`);
  if (opts.corrupt === true) {
    writeFileSync(file, "not-json\n", "utf8");
  } else {
    const line = JSON.stringify({
      type: "session_meta",
      payload: {
        id: opts.id,
        cwd: opts.cwd,
        timestamp,
      },
    });
    const markerLine =
      opts.marker === undefined
        ? ""
        : `${JSON.stringify({ type: "response_item", text: `ffpane-claim:${opts.marker}` })}\n`;
    writeFileSync(file, `${line}\n${markerLine}`, "utf8");
  }
  return file;
}

describe("parseCodexRolloutSessionMeta", () => {
  it("解析首行 session_meta", () => {
    const meta = parseCodexRolloutSessionMeta(
      "x.jsonl",
      `${JSON.stringify({
        type: "session_meta",
        payload: { id: "abc", cwd: "D:\\\\repo", timestamp: "2026-10-01T00:00:00.000Z" },
      })}\n`,
      1,
    );
    expect(meta?.id).toBe("abc");
    expect(cwdEquals(meta?.cwd ?? "", "D:\\repo")).toBe(true);
  });

  it("首行损坏返回 undefined", () => {
    expect(parseCodexRolloutSessionMeta("x.jsonl", "{bad\n", 1)).toBeUndefined();
  });
});

describe("collectCodexSessionScanDayDirs 时区", () => {
  it("UTC+8 凌晨 3 点：本地 10/01 与 UTC 09/30 均在扫描集（含 ±1 日）", () => {
    // 2026-09-30T19:00:00Z = UTC+8 2026-10-01 03:00
    const at = Date.parse("2026-09-30T19:00:00.000Z");
    const dirs = collectCodexSessionScanDayDirs("/s", [at], {
      localDayParts: offsetLocalParts(8),
    });
    const rel = dirs.map((d) => d.replace(/\\/g, "/"));
    expect(rel.some((d) => d.endsWith("/2026/10/01"))).toBe(true);
    expect(rel.some((d) => d.endsWith("/2026/09/30"))).toBe(true);
    expect(rel.some((d) => d.endsWith("/2026/09/29"))).toBe(true);
    expect(rel.some((d) => d.endsWith("/2026/10/02"))).toBe(true);
  });

  it("UTC-8 晚 23 点：本地 09/30 与 UTC 10/01 均在扫描集", () => {
    // 2026-10-01T06:00:00Z = UTC-8 2026-09-30 23:00
    const at = Date.parse("2026-10-01T06:00:00.000Z");
    const dirs = collectCodexSessionScanDayDirs("/s", [at], {
      localDayParts: offsetLocalParts(-8),
    });
    const rel = dirs.map((d) => d.replace(/\\/g, "/"));
    expect(rel.some((d) => d.endsWith("/2026/09/30"))).toBe(true);
    expect(rel.some((d) => d.endsWith("/2026/10/01"))).toBe(true);
  });

  it("shiftDayParts 跨月正确", () => {
    expect(formatDayDir(shiftDayParts({ y: 2026, m: 10, d: 1 }, -1))).toBe("2026/09/30");
    expect(formatDayDir(shiftDayParts({ y: 2026, m: 1, d: 1 }, -1))).toBe("2025/12/31");
  });
});

describe("测试隔离守卫", () => {
  it("真实 ~/.codex 路径被识别", () => {
    expect(isRealUserCodexPath(join(homedir(), ".codex"))).toBe(true);
    expect(isRealUserCodexPath(join(homedir(), ".codex", "sessions"))).toBe(true);
    expect(isRealUserCodexPath(join(tmpdir(), "ffpane-isolated-codex"))).toBe(false);
  });

  it("自动化环境下指向真实 ~/.codex 会抛错", () => {
    expect(() =>
      assertTestCodexHomeIsolated(join(homedir(), ".codex"), {
        VITEST: "true",
      }),
    ).toThrow(/test isolation violated/);
    expect(() =>
      assertTestCodexHomeIsolated(join(homedir(), ".codex"), {
        FF_PANE_E2E: "1",
      }),
    ).toThrow(/test isolation violated/);
  });

  it("临时 CODEX_HOME 通过守卫", () => {
    const home = fakeHome();
    expect(() => assertTestCodexHomeIsolated(home, { VITEST: "true" })).not.toThrow();
  });

  it("仅设 FF_PANE_DATA_ROOT 不视为测试环境，真实 ~/.codex 不抛且认领正常", async () => {
    const portableEnv = {
      FF_PANE_DATA_ROOT: join(tmpdir(), "ffpane-portable-data-root"),
    };
    expect(isAutomatedTestEnv(portableEnv)).toBe(false);
    expect(() => assertTestCodexHomeIsolated(join(homedir(), ".codex"), portableEnv)).not.toThrow();

    const home = fakeHome();
    const cwd = join(home, "proj");
    mkdirSync(cwd, { recursive: true });
    const t0 = Date.now() - 5_000;
    writeRollout(home, {
      id: "portable-ok",
      cwd,
      timestampMs: t0 + 1_000,
      marker: "11111111-1111-4111-8111-111111111111",
    });
    const claimer = new CodexSessionClaimer({
      codexHome: home,
      now: () => Date.now(),
      intervalMs: 20,
      timeoutMs: 500,
    });
    const id = await claimer.start({
      windowId: "w-portable",
      cwd,
      startedAtMs: t0,
      claimMarker: "11111111-1111-4111-8111-111111111111",
    });
    expect(id).toBe("portable-ok");
    claimer.dispose();
  });

  it("tick 异常会写入 warn 日志而不静默", () => {
    const logs: string[] = [];
    const claimer = new CodexSessionClaimer({
      codexHome: fakeHome(),
      logWarn: (message) => {
        logs.push(message);
      },
      localDayParts: () => {
        throw new Error("simulated-scan-boom");
      },
      intervalMs: 20,
      timeoutMs: 50,
    });
    // start → tick → scanMetas → collect day dirs 抛错
    void claimer.start({
      windowId: "w-log",
      cwd: join(tmpdir(), "proj"),
      startedAtMs: Date.now(),
      claimMarker: "22222222-2222-4222-8222-222222222222",
    });
    expect(logs.some((line) => line.includes("[codex-claim] tick failed"))).toBe(true);
    expect(logs.some((line) => line.includes("simulated-scan-boom"))).toBe(true);
    claimer.dispose();
  });
});

describe("CodexSessionClaimer", () => {
  it("单窗口认领匹配 cwd 且时间在启动后", async () => {
    const home = fakeHome();
    const cwd = join(home, "proj");
    mkdirSync(cwd, { recursive: true });
    const t0 = Date.now() - 5_000;
    writeRollout(home, {
      id: "sess-1",
      cwd,
      timestampMs: t0 + 1_000,
      marker: "33333333-3333-4333-8333-333333333333",
    });
    const claimer = new CodexSessionClaimer({
      codexHome: home,
      now: () => Date.now(),
      intervalMs: 20,
      timeoutMs: 500,
    });
    const id = await claimer.start({
      windowId: "w1",
      cwd,
      startedAtMs: t0,
      claimMarker: "33333333-3333-4333-8333-333333333333",
    });
    expect(id).toBe("sess-1");
    claimer.dispose();
  });

  it("本地日目录在 UTC 仍为昨日时也能认领（模拟 UTC+8 凌晨）", async () => {
    const home = fakeHome();
    const cwd = join(home, "proj");
    mkdirSync(cwd, { recursive: true });
    // 固定时钟：UTC+8 2026-10-01 03:00 = 2026-09-30T19:00Z
    const now = Date.parse("2026-09-30T19:00:00.000Z");
    const t0 = now - 5_000;
    const localDay = formatDayDir(offsetLocalParts(8)(now));
    expect(localDay).toBe("2026/10/01");
    expect(formatDayDir(utcDayParts(now))).toBe("2026/09/30");
    writeRollout(home, {
      id: "local-dawn",
      cwd,
      timestampMs: t0 + 1_000,
      dayPath: localDay,
      marker: "44444444-4444-4444-8444-444444444444",
    });
    const claimer = new CodexSessionClaimer({
      codexHome: home,
      now: () => now,
      localDayParts: offsetLocalParts(8),
      // 虚构时钟下用会话时间冒充 mtime，避免真实 mtime 被窗口过滤掉
      statMtimeMs: () => t0 + 1_000,
      intervalMs: 20,
      timeoutMs: 500,
    });
    const id = await claimer.start({
      windowId: "w1",
      cwd,
      startedAtMs: t0,
      claimMarker: "44444444-4444-4444-8444-444444444444",
    });
    expect(id).toBe("local-dawn");
    claimer.dispose();
  });

  it("cwd 不匹配不认领", async () => {
    const home = fakeHome();
    const cwd = join(home, "proj-a");
    mkdirSync(cwd, { recursive: true });
    const t0 = Date.now() - 5_000;
    writeRollout(home, {
      id: "sess-x",
      cwd: join(home, "proj-b"),
      timestampMs: t0 + 1_000,
      marker: "55555555-5555-4555-8555-555555555555",
    });
    let now = t0 + 2_000;
    const claimer = new CodexSessionClaimer({
      codexHome: home,
      now: () => {
        now += 40;
        return now;
      },
      intervalMs: 20,
      timeoutMs: 120,
    });
    const id = await claimer.start({
      windowId: "w1",
      cwd,
      startedAtMs: t0,
      claimMarker: "55555555-5555-4555-8555-555555555555",
    });
    expect(id).toBeUndefined();
    claimer.dispose();
  });

  it("同目录多个窗口按各自记号认领，不按启动先后", async () => {
    const home = fakeHome();
    const cwd = join(home, "proj");
    mkdirSync(cwd, { recursive: true });
    const t0 = Date.now() - 5_000;
    const markers = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
    ] as const;
    markers.forEach((marker, index) => {
      writeRollout(home, {
        id: `sess-${index}`,
        cwd,
        timestampMs: t0 + (markers.length - index) * 1_000,
        marker,
      });
    });
    const now = t0 + 20_000;
    const claimer = new CodexSessionClaimer({
      codexHome: home,
      now: () => now,
      intervalMs: 20,
      timeoutMs: 1_000,
    });
    const ids = await Promise.all(
      markers.map((marker, index) =>
        claimer.start({
          windowId: `w-${index}`,
          cwd,
          startedAtMs: t0 + index,
          claimMarker: marker,
        }),
      ),
    );
    expect(ids).toEqual(["sess-0", "sess-1", "sess-2", "sess-3", "sess-4"]);
    claimer.dispose();
  });

  it("记号撞车或对不上时不认领", async () => {
    const home = fakeHome();
    const cwd = join(home, "proj");
    mkdirSync(cwd, { recursive: true });
    const t0 = Date.now() - 5_000;
    const shared = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    writeRollout(home, { id: "one", cwd, timestampMs: t0 + 1_000, marker: shared });
    writeRollout(home, { id: "two", cwd, timestampMs: t0 + 2_000, marker: shared });
    writeRollout(home, {
      id: "other",
      cwd,
      timestampMs: t0 + 3_000,
      marker: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    let now = t0 + 4_000;
    const claimer = new CodexSessionClaimer({
      codexHome: home,
      now: () => {
        now += 50;
        return now;
      },
      intervalMs: 20,
      timeoutMs: 200,
    });
    const collided = await claimer.start({
      windowId: "w-collide",
      cwd,
      startedAtMs: t0,
      claimMarker: shared,
    });
    const missing = await claimer.start({
      windowId: "w-missing",
      cwd,
      startedAtMs: t0,
      claimMarker: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
    expect(collided).toBeUndefined();
    expect(missing).toBeUndefined();
    claimer.dispose();
  });

  it("记号同时出现在干净文件和多记号文件里时两份都不认", () => {
    const marker = "abababab-abab-4aba-8aba-abababababab";
    const other = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
    const t0 = Date.now() - 5_000;
    const cwd = "D:\\repo";
    const clean: CodexSessionMeta = {
      id: "clean",
      cwd,
      timestampMs: t0 + 1_000,
      filePath: "clean.jsonl",
      claimMarkers: [marker],
    };
    const mixed: CodexSessionMeta = {
      id: "mixed",
      cwd,
      timestampMs: t0 + 2_000,
      filePath: "mixed.jsonl",
      claimMarkers: [marker, other],
    };
    const pick = pickCodexSessionForClaim(
      { windowId: "w", cwd, startedAtMs: t0, claimMarker: marker },
      [clean, mixed],
      new Set(),
    );
    expect(pick.status).toBe("collision");
  });

  it("文件延迟出现后仍可认领", async () => {
    const home = fakeHome();
    const cwd = join(home, "proj");
    mkdirSync(cwd, { recursive: true });
    const t0 = Date.now() - 1_000;
    let now = t0 + 100;
    const claimer = new CodexSessionClaimer({
      codexHome: home,
      now: () => now,
      intervalMs: 30,
      timeoutMs: 2_000,
    });
    const pending = claimer.start({
      windowId: "w1",
      cwd,
      startedAtMs: t0,
      claimMarker: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    });
    await new Promise((r) => setTimeout(r, 60));
    writeRollout(home, {
      id: "delayed",
      cwd,
      timestampMs: t0 + 200,
      marker: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    });
    now = t0 + 500;
    const id = await pending;
    expect(id).toBe("delayed");
    claimer.dispose();
  });

  it("首行损坏的文件被跳过", () => {
    const home = fakeHome();
    const cwd = join(home, "proj");
    const t0 = Date.now() - 5_000;
    writeRollout(home, {
      id: "bad",
      cwd,
      timestampMs: t0 + 1_000,
      corrupt: true,
      marker: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    });
    writeRollout(home, {
      id: "good",
      cwd,
      timestampMs: t0 + 2_000,
      marker: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    });
    const claimer = new CodexSessionClaimer({ codexHome: home });
    const pick = pickCodexSessionForClaim(
      {
        windowId: "w",
        cwd,
        startedAtMs: t0,
        claimMarker: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      },
      claimer.scanMetas(),
      new Set(),
    );
    expect(pick.status).toBe("matched");
    if (pick.status === "matched") {
      expect(pick.meta.id).toBe("good");
    }
  });

  it("超大 jsonl 只读首行，不整文件入内存", () => {
    const home = fakeHome();
    const dir = join(home, "sessions", "2026", "10", "01");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "rollout-huge.jsonl");
    const meta = JSON.stringify({
      type: "session_meta",
      payload: {
        id: "huge-1",
        cwd: "D:\\repo",
        timestamp: "2026-10-01T12:00:05.000Z",
      },
    });
    writeFileSync(file, `${meta}\n${"Q".repeat(8 * 1024 * 1024)}`, "utf8");
    const line = readFileFirstLine(file, 64 * 1024);
    expect(line).toBe(meta);
    expect(line?.includes("Q")).toBe(false);
    const parsed = parseCodexRolloutSessionMeta(file, line ?? "", Date.now());
    expect(parsed?.id).toBe("huge-1");
  });
});
