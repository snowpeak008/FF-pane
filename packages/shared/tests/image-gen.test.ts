/**
 * 生图设置：缺省是先不生图；换方案留下中转站；明文密钥不进入可落盘对象。
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_GLOBAL_CONFIG,
  imageGenModeOf,
  mergeImageGenSettings,
  sanitizeImageGenSettings,
} from "../src/index.js";

const SECRET = "sk-test-image-key-should-not-leak";

describe("生图设置", () => {
  it("出厂默认不含 imageGen，缺省等于先不生图", () => {
    expect(DEFAULT_GLOBAL_CONFIG.imageGen).toBeUndefined();
    expect(imageGenModeOf(undefined)).toBe("off");
    expect(sanitizeImageGenSettings(undefined)).toBeUndefined();
  });

  it("只改方案时留下中转站", () => {
    const saved = mergeImageGenSettings(undefined, {
      mode: "relay",
      relay: {
        baseUrl: "https://relay.example/v1",
        model: "gpt-image-2",
        apiKeyRef: "key-kept",
      },
    });
    const off = mergeImageGenSettings(saved, { mode: "off" });
    expect(off?.mode).toBe("off");
    expect(off?.relay).toEqual({
      baseUrl: "https://relay.example/v1",
      model: "gpt-image-2",
      apiKeyRef: "key-kept",
    });
  });

  it("补丁里的明文密钥不会进入结果", () => {
    const merged = mergeImageGenSettings(undefined, {
      mode: "relay",
      apiKey: SECRET,
      relay: {
        baseUrl: "https://relay.example/v1",
        model: "gpt-image-2",
        apiKeyRef: "key-kept",
        apiKey: SECRET,
        token: SECRET,
      },
    });
    expect(JSON.stringify(merged)).not.toContain(SECRET);
    expect(merged?.relay).toEqual({
      baseUrl: "https://relay.example/v1",
      model: "gpt-image-2",
      apiKeyRef: "key-kept",
    });
    expect(Object.keys(merged?.relay ?? {})).toEqual(["baseUrl", "model", "apiKeyRef"]);
  });
});
