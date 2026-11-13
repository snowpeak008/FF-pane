/**
 * T11.0d：诊断与兜底的判断规则。
 */

import { describe, expect, it } from "vitest";
import {
  decideRendererGone,
  formatMemoryLine,
  GPU_STUCK_CPU_SECONDS,
  HEAP_SNAPSHOT_MB,
  isGpuStuck,
  logFileNameFor,
  MEMORY_WARN_MB,
  type MemorySample,
  memoryWarningOf,
  RENDERER_RELOAD_WINDOW_MS,
  shouldWriteHeapSnapshot,
  staleLogFiles,
} from "../src/main/diagnostics/policy";

const base: MemorySample = {
  mainRssMb: 300,
  mainHeapUsedMb: 120,
  mainExternalMb: 20,
  mainArrayBuffersMb: 10,
  rendererMb: 500,
  gpuMb: 150,
  terminals: 3,
  terminalBufferedMb: 2,
};

describe("decideRendererGone", () => {
  it("正常退出不管", () => {
    expect(decideRendererGone("clean-exit", [], 1000).action).toBe("none");
  });

  it("崩了就重载，一分钟内第 4 次放弃", () => {
    let recent: readonly number[] = [];
    const actions: string[] = [];
    for (const at of [0, 10_000, 20_000, 30_000]) {
      const decided = decideRendererGone("crashed", recent, at);
      actions.push(decided.action);
      recent = decided.recent;
    }
    expect(actions).toEqual(["reload", "reload", "reload", "give-up"]);
  });

  it("隔了一分钟以上的旧记录不算", () => {
    const decided = decideRendererGone(
      "oom",
      [0, 1000, 2000],
      2000 + RENDERER_RELOAD_WINDOW_MS + 1,
    );
    expect(decided.action).toBe("reload");
    expect(decided.recent).toHaveLength(1);
  });
});

describe("内存警戒和快照", () => {
  it("没超不提示", () => {
    expect(memoryWarningOf(base)).toBeUndefined();
  });

  it("主进程超了先报主进程", () => {
    expect(
      memoryWarningOf({ ...base, mainRssMb: MEMORY_WARN_MB, rendererMb: MEMORY_WARN_MB + 1 }),
    ).toEqual({ kind: "main", mb: MEMORY_WARN_MB });
  });

  it("界面进程超了报界面进程；拿不到界面内存不报", () => {
    expect(memoryWarningOf({ ...base, rendererMb: 3000 })).toEqual({
      kind: "renderer",
      mb: 3000,
    });
    const { rendererMb: _omit, ...withoutRenderer } = base;
    expect(memoryWarningOf(withoutRenderer)).toBeUndefined();
  });

  it("堆快照只写一次", () => {
    const high = { ...base, mainHeapUsedMb: HEAP_SNAPSHOT_MB };
    expect(shouldWriteHeapSnapshot(base, false)).toBe(false);
    expect(shouldWriteHeapSnapshot(high, false)).toBe(true);
    expect(shouldWriteHeapSnapshot(high, true)).toBe(false);
  });

  it("记录一行带上各项", () => {
    const line = formatMemoryLine(base);
    expect(line).toContain("rss=300MB");
    expect(line).toContain("renderer=500MB");
    expect(line).toContain("terminals=3");
  });
});

describe("日志文件", () => {
  it("按本地日期起名", () => {
    expect(logFileNameFor(new Date(2026, 9, 7, 23, 59))).toBe("main-2026-10-07.log");
  });

  it("超过 7 天的才删，别的文件不动", () => {
    const now = new Date(2026, 9, 27, 12, 0);
    expect(
      staleLogFiles(
        [
          "main-2026-10-27.log",
          "main-2026-10-21.log",
          "main-2026-10-20.log",
          "main-2026-09-01.log",
          "heap-1.heapsnapshot",
          "notes.txt",
        ],
        now,
      ),
    ).toEqual(["main-2026-10-20.log", "main-2026-09-01.log"]);
  });
});

describe("isGpuStuck（T11.13）", () => {
  it("同一个 GPU 进程这段时间几乎没用 CPU：判卡死", () => {
    expect(isGpuStuck({ pid: 7, cpuSeconds: 12 }, { pid: 7, cpuSeconds: 12.1 })).toBe(true);
    expect(isGpuStuck({ pid: 7, cpuSeconds: 12 }, { pid: 7, cpuSeconds: 12 })).toBe(true);
  });

  it("GPU 进程在干活：不判", () => {
    expect(
      isGpuStuck({ pid: 7, cpuSeconds: 12 }, { pid: 7, cpuSeconds: 12 + GPU_STUCK_CPU_SECONDS }),
    ).toBe(false);
  });

  it("GPU 进程中途换了、或拿不到数：不判", () => {
    expect(isGpuStuck({ pid: 7, cpuSeconds: 12 }, { pid: 8, cpuSeconds: 0 })).toBe(false);
    expect(isGpuStuck(undefined, { pid: 7, cpuSeconds: 12 })).toBe(false);
    expect(isGpuStuck({ pid: 7, cpuSeconds: 12 }, undefined)).toBe(false);
  });
});
