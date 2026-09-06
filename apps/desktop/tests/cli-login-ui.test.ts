/**
 * T9.2 ②③ 的渲染层纯逻辑：登录态探测缓存（TTL / 在飞去重 / 强制刷新）+
 * cli_login 模型手填禁用判定 + 契约镜像常量与 adapters 权威值一致。
 */

import {
  CLI_LOGIN_RUNTIMES,
  DEFAULT_PROBE_TIMEOUT_MS,
  LOCAL_MODEL_RUNTIMES,
} from "@ff-pane/adapters";
import { describe, expect, it } from "vitest";
import { createCliLoginProbeCache } from "../src/renderer/src/pages/settings/providers/cli-login-probe";
import { usesCliEnumeratedModels } from "../src/renderer/src/pages/settings/providers/provider-form";
import {
  CLI_LOGIN_RUNTIME_WIRES,
  type CliLoginProbeView,
  LOCAL_MODEL_RUNTIME_WIRES,
  supportsLocalModelsWire,
} from "../src/shared-ipc/contracts";

function probeResult(status: CliLoginProbeView["status"]): CliLoginProbeView {
  return { status, detail: `detail-${status}`, probedWith: "probe cmd" };
}

describe("契约镜像常量与 adapters 权威值一致（T9.2 钉住承诺）", () => {
  it("CLI_LOGIN_RUNTIME_WIRES = CLI_LOGIN_RUNTIMES", () => {
    expect([...CLI_LOGIN_RUNTIME_WIRES]).toEqual([...CLI_LOGIN_RUNTIMES]);
  });

  it("LOCAL_MODEL_RUNTIME_WIRES = LOCAL_MODEL_RUNTIMES", () => {
    expect([...LOCAL_MODEL_RUNTIME_WIRES]).toEqual([...LOCAL_MODEL_RUNTIMES]);
  });

  it("supportsLocalModelsWire 与调研结论一致（claude/gemini 无按钮）", () => {
    expect(supportsLocalModelsWire("codex")).toBe(true);
    expect(supportsLocalModelsWire("opencode")).toBe(true);
    expect(supportsLocalModelsWire("grok-build")).toBe(true);
    expect(supportsLocalModelsWire("claude-code")).toBe(false);
    expect(supportsLocalModelsWire("gemini-cli")).toBe(false);
  });
});

describe("登录态探测缓存（cli-login-probe）", () => {
  it("TTL 内复用缓存，不重复探测", async () => {
    let calls = 0;
    let now = 1_000;
    const cache = createCliLoginProbeCache(
      async () => {
        calls += 1;
        return probeResult("logged_in");
      },
      () => now,
      30_000,
    );
    await cache.probe("codex");
    now += 10_000;
    const second = await cache.probe("codex");
    expect(calls).toBe(1);
    expect(second.status).toBe("logged_in");
  });

  it("TTL 过期后重探", async () => {
    let calls = 0;
    let now = 1_000;
    const cache = createCliLoginProbeCache(
      async () => {
        calls += 1;
        return probeResult("logged_out");
      },
      () => now,
      30_000,
    );
    await cache.probe("opencode");
    now += 30_001;
    await cache.probe("opencode");
    expect(calls).toBe(2);
  });

  it("在飞去重：同 runtime 并发探测共享同一个 promise", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const cache = createCliLoginProbeCache(async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return probeResult("unknown");
    });
    const first = cache.probe("grok-build");
    const second = cache.probe("grok-build");
    release?.();
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it("force 绕过缓存强制重探（手动刷新旁路）", async () => {
    let calls = 0;
    const cache = createCliLoginProbeCache(async () => {
      calls += 1;
      return probeResult("logged_in");
    });
    await cache.probe("codex");
    await cache.probe("codex", true);
    expect(calls).toBe(2);
  });

  it("不同 runtime 各自独立缓存", async () => {
    const seen: string[] = [];
    const cache = createCliLoginProbeCache(async (runtime) => {
      seen.push(runtime);
      return probeResult("logged_in");
    });
    await cache.probe("codex");
    await cache.probe("opencode");
    expect(seen).toEqual(["codex", "opencode"]);
  });

  it("探测超时缺省 10s（adapters DEFAULT_PROBE_TIMEOUT_MS 的现实口径备忘）", () => {
    // Node 系 CLI 冷启动秒级，UI 侧缓存 + 在飞去重就是为它存在的
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(10_000);
  });
});

describe("cli_login 模型手填禁用判定（T9.2 ③）", () => {
  it("仅 cli_login 类型走 CLI 枚举（手填入口隐藏）", () => {
    expect(usesCliEnumeratedModels("cli_login")).toBe(true);
    expect(usesCliEnumeratedModels("openai_compatible")).toBe(false);
    expect(usesCliEnumeratedModels("anthropic")).toBe(false);
    expect(usesCliEnumeratedModels("custom")).toBe(false);
  });
});
