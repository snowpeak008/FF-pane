/**
 * Codex 会话识别：由本窗口的 notify 报 thread-id，不扫描 sessions 目录。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertTestCodexHomeIsolated,
  CodexSessionClaimer,
  cwdEquals,
  isAutomatedTestEnv,
  isCodexThreadId,
  isRealUserCodexPath,
} from "../src/main/workbench/codex-claim";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ID_A = "01a1588d-18e8-77a3-b90f-e5fcfd74f597";
const ID_B = "01a15788-c721-7232-841b-3fbf3901a9fd";

describe("CodexSessionClaimer", () => {
  it("各窗口只认自己报来的编号，不按启动先后", async () => {
    const claimer = new CodexSessionClaimer();
    const first = claimer.start({ windowId: "w1" });
    const second = claimer.start({ windowId: "w2" });
    expect(claimer.noteThreadId("w2", ID_B)).toBe(true);
    expect(claimer.noteThreadId("w1", ID_A)).toBe(true);
    await expect(first).resolves.toBe(ID_A);
    await expect(second).resolves.toBe(ID_B);
    expect(claimer.isWaiting("w1")).toBe(false);
  });

  it("不是会话编号的值不认；没在等的窗口返回 false", async () => {
    const claimer = new CodexSessionClaimer();
    const pending = claimer.start({ windowId: "w1" });
    expect(claimer.noteThreadId("w1", "../../etc")).toBe(false);
    expect(claimer.noteThreadId("w9", ID_A)).toBe(false);
    expect(claimer.isWaiting("w1")).toBe(true);
    claimer.cancel("w1");
    await expect(pending).resolves.toBeUndefined();
  });

  it("没有超时：迟迟不发第一条消息也一直等，窗口退出才交回 undefined", async () => {
    const claimer = new CodexSessionClaimer();
    const pending = claimer.start({ windowId: "w1" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(claimer.isWaiting("w1")).toBe(true);
    claimer.dispose();
    await expect(pending).resolves.toBeUndefined();
  });

  it("重新开始等时，旧的那次交回 undefined", async () => {
    const claimer = new CodexSessionClaimer();
    const old = claimer.start({ windowId: "w1" });
    const fresh = claimer.start({ windowId: "w1" });
    await expect(old).resolves.toBeUndefined();
    claimer.noteThreadId("w1", ID_A);
    await expect(fresh).resolves.toBe(ID_A);
  });

  it("会话编号只认 UUID 形状", () => {
    expect(isCodexThreadId(ID_A)).toBe(true);
    expect(isCodexThreadId("not-a-uuid")).toBe(false);
    expect(isCodexThreadId(42)).toBe(false);
  });

  it("源码里不再扫描 sessions 目录", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      join(__dirname, "..", "src", "main", "workbench", "codex-claim.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/readdirSync|readSync|statSync|openSync/);
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
    const home = mkdtempSync(join(tmpdir(), "ffpane-codex-home-"));
    temps.push(home);
    expect(() => assertTestCodexHomeIsolated(home, { VITEST: "true" })).not.toThrow();
    expect(isAutomatedTestEnv({ VITEST: "true" })).toBe(true);
    expect(isAutomatedTestEnv({ FF_PANE_DATA_ROOT: "x" })).toBe(false);
    expect(cwdEquals("C:\\A\\b\\", "c:\\a\\B")).toBe(process.platform === "win32");
  });
});
