import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSCRIPT_LIMIT,
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  isValidChannelName,
} from "../src/shared-ipc/contracts";

describe("IPC 通道契约", () => {
  it("全部登记通道符合 <域>:<动作> 命名规范", () => {
    for (const channel of [...INVOKE_CHANNELS, ...EVENT_CHANNELS]) {
      expect(isValidChannelName(channel), `通道名非法：${channel}`).toBe(true);
    }
  });

  it("拒绝不符合命名规范的通道名", () => {
    const illegalNames = [
      "",
      "ping",
      "app:",
      ":ping",
      "App:ping",
      "app:Ping",
      "app.ping",
      "app :ping",
      "app:ping:extra",
      "app_x:ping",
      "1app:ping",
    ];
    for (const name of illegalNames) {
      expect(isValidChannelName(name), `不应通过：${name}`).toBe(false);
    }
  });

  it("invoke 清单与事件清单内部无重复", () => {
    expect(new Set(INVOKE_CHANNELS).size).toBe(INVOKE_CHANNELS.length);
    expect(new Set(EVENT_CHANNELS).size).toBe(EVENT_CHANNELS.length);
  });

  it("invoke 清单与事件清单互不重叠", () => {
    const invokeSet = new Set<string>(INVOKE_CHANNELS);
    for (const channel of EVENT_CHANNELS) {
      expect(invokeSet.has(channel), `通道同时出现在两个清单：${channel}`).toBe(false);
    }
  });

  it("T8.2b 会话续接通道已登记到运行时清单（preload 据此放行）", () => {
    expect(INVOKE_CHANNELS).toContain("sessions:latest");
    expect(INVOKE_CHANNELS).toContain("sessions:transcript");
    // 尾部缺省 200 条 ≈ 60 轮 × 3 条，百条消息级会话一次取齐
    expect(DEFAULT_TRANSCRIPT_LIMIT).toBe(200);
  });

  it("T8.3a 并发轮次查询通道已登记到运行时清单", () => {
    expect(INVOKE_CHANNELS).toContain("sessions:active-turns");
  });

  it("T8.4 自定义角色 CRUD 四通道已登记到运行时清单（preload 据此放行）", () => {
    for (const channel of ["roles:list", "roles:create", "roles:update", "roles:remove"]) {
      expect(INVOKE_CHANNELS, `缺通道：${channel}`).toContain(channel);
    }
  });

  it("T8.7 记忆混合检索通道已登记到运行时清单（preload 据此放行）", () => {
    expect(INVOKE_CHANNELS).toContain("memory:search");
  });
});
