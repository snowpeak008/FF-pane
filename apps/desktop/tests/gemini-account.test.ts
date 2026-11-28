/**
 * T11.23 §10：Gemini 账号状态。只看 agy 在不在、凭据管理器里有没有 gemini:antigravity 条目。
 * 全部用注入的假依赖，不碰真实的 cmdkey、不调用模型。
 */

import { describe, expect, it } from "vitest";
import {
  type GeminiStatusDeps,
  hasAgyCredential,
  readGeminiAccountStatus,
} from "../src/main/gemini-account";

// 真实 cmdkey /list 的形状：条目名是纯 ASCII，其余是本地化文字（这里用乱码字节模拟）。
const LISTING = [
  "",
  "\u0001\u0002\u0003: LegacyGeneric:target=git:https://github.com",
  "\u0001\u0002\u0003: LegacyGeneric:target=gemini:antigravity",
  "\u0001\u0002\u0003: LegacyGeneric:target=UnityHub/combinedTokens",
].join("\r\n");

function deps(overrides: Partial<GeminiStatusDeps>): GeminiStatusDeps {
  return {
    platform: "win32",
    resolveTarget: () => "C:\\agy.exe",
    listCredentials: async () => LISTING,
    ...overrides,
  };
}

describe("hasAgyCredential", () => {
  it("命中 gemini:antigravity 这一条", () => {
    expect(hasAgyCredential(LISTING)).toBe(true);
  });

  it("没有这一条就不命中", () => {
    expect(hasAgyCredential("x: LegacyGeneric:target=git:https://github.com\r\n")).toBe(false);
    expect(hasAgyCredential("")).toBe(false);
  });

  it("名字只是前缀相同的别的条目不算", () => {
    expect(hasAgyCredential("x: LegacyGeneric:target=gemini:antigravity-old\r\n")).toBe(false);
    expect(hasAgyCredential("x: LegacyGeneric:target=gemini:antigravityX")).toBe(false);
  });

  it("最后一行没有换行也能命中，行尾空格不影响", () => {
    expect(hasAgyCredential("x: LegacyGeneric:target=gemini:antigravity")).toBe(true);
    expect(hasAgyCredential("x: LegacyGeneric:target=gemini:antigravity  \r\n")).toBe(true);
  });
});

describe("readGeminiAccountStatus", () => {
  it("没装 agy：installed=false，不去读凭据管理器", async () => {
    let called = false;
    const status = await readGeminiAccountStatus(
      {},
      deps({
        resolveTarget: () => undefined,
        listCredentials: async () => {
          called = true;
          return LISTING;
        },
      }),
    );
    expect(status).toEqual({ installed: false });
    expect(called).toBe(false);
  });

  it("装了而且有登录条目：已登录", async () => {
    const status = await readGeminiAccountStatus({}, deps({}));
    expect(status).toEqual({ installed: true, authenticated: true });
  });

  it("装了但没有登录条目：没登录", async () => {
    const status = await readGeminiAccountStatus(
      {},
      deps({ listCredentials: async () => "x: LegacyGeneric:target=git:https://github.com\r\n" }),
    );
    expect(status).toEqual({ installed: true, authenticated: false });
  });

  it("读凭据管理器失败：判断不了，带原因，不抛错", async () => {
    const status = await readGeminiAccountStatus(
      {},
      deps({
        listCredentials: async () => {
          throw new Error("spawn cmdkey ENOENT");
        },
      }),
    );
    expect(status.installed).toBe(true);
    expect(status.authenticated).toBeUndefined();
    expect(status.detail).toContain("ENOENT");
  });

  it("不是 Windows：装了但判断不了登录状态", async () => {
    const status = await readGeminiAccountStatus({}, deps({ platform: "linux" }));
    expect(status.installed).toBe(true);
    expect(status.authenticated).toBeUndefined();
    expect(status.detail).toContain("Windows");
  });
});
