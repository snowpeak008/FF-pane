import { describe, expect, it } from "vitest";
import {
  cleanSandboxDomains,
  DEFAULT_SANDBOX_NETWORK_DOMAINS,
  isValidSandboxDomain,
  sandboxNetworkDomainsFor,
} from "../src/index.js";

describe("沙盒网络名单（T11.20）", () => {
  it("收普通域名、通配子域名、带端口的", () => {
    for (const ok of ["pypi.org", "*.github.com", "api.example.com:443", "a-b.co.uk"]) {
      expect(isValidSandboxDomain(ok), ok).toBe(true);
    }
  });

  it("不收 sandbox-runtime 会拒的太宽写法，也不收 IP、空串、坏端口", () => {
    for (const bad of [
      "*",
      "*.com",
      "com",
      "",
      "  ",
      "1.2.3.4",
      "a..com",
      "-a.com",
      "a.com:0",
      "a.com:70000",
      "*.*.com",
    ]) {
      expect(isValidSandboxDomain(bad), bad).toBe(false);
    }
  });

  it("清理：转小写、去重、不合法的单独列出", () => {
    expect(cleanSandboxDomains(["Unity3D.com", "unity3d.com", " ", "*", "x.org"])).toEqual({
      domains: ["unity3d.com", "x.org"],
      invalid: ["*"],
    });
  });

  it("窗口用的名单是默认名单加项目加的，不重复", () => {
    expect(sandboxNetworkDomainsFor(undefined)).toEqual(DEFAULT_SANDBOX_NETWORK_DOMAINS);
    expect(sandboxNetworkDomainsFor(["github.com", "unity3d.com"])).toEqual([
      ...DEFAULT_SANDBOX_NETWORK_DOMAINS,
      "unity3d.com",
    ]);
  });
});
