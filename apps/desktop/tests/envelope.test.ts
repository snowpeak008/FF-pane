import { describe, expect, it } from "vitest";
import {
  errResult,
  IpcInvokeError,
  isIpcResult,
  okResult,
  unwrapIpcResult,
} from "../src/shared-ipc/envelope";

describe("IPC 结果信封", () => {
  it("okResult 往返解包得到原值", () => {
    const value = { hello: "world", nested: { count: 3 } };
    expect(unwrapIpcResult(okResult(value), "app:ping")).toEqual(value);
  });

  it("okResult 支持 undefined 作为合法返回值", () => {
    expect(unwrapIpcResult(okResult(undefined), "app:ping")).toBeUndefined();
  });

  it("errResult 保留 Error 的名称、消息与堆栈", () => {
    const result = errResult("app:ping", new RangeError("out of range"));
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("期望得到错误信封");
    }
    expect(result.error.channel).toBe("app:ping");
    expect(result.error.name).toBe("RangeError");
    expect(result.error.message).toBe("out of range");
    expect(result.error.stack).toBeTypeOf("string");
  });

  it("errResult 规范化非 Error 抛出值（对象 / 字符串）", () => {
    const objectResult = errResult("app:ping", { code: 42 });
    if (objectResult.ok) {
      throw new Error("期望得到错误信封");
    }
    expect(objectResult.error.name).toBe("NonErrorThrown");
    expect(objectResult.error.message).toContain("42");

    const stringResult = errResult("app:ping", "纯字符串异常");
    if (stringResult.ok) {
      throw new Error("期望得到错误信封");
    }
    expect(stringResult.error.message).toBe("纯字符串异常");
  });

  it("解包错误信封抛出 IpcInvokeError 且携带远端错误信息", () => {
    const envelope = errResult("diagnostics:check-sqlite", new Error("boom"));
    let caught: unknown;
    try {
      unwrapIpcResult(envelope, "diagnostics:check-sqlite");
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(IpcInvokeError);
    const error = caught as IpcInvokeError;
    expect(error.channel).toBe("diagnostics:check-sqlite");
    expect(error.remoteName).toBe("Error");
    expect(error.message).toContain("diagnostics:check-sqlite");
    expect(error.message).toContain("boom");
  });

  it("解包非法形状抛出 MalformedIpcResult", () => {
    let caught: unknown;
    try {
      unwrapIpcResult({ unexpected: true }, "app:ping");
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(IpcInvokeError);
    expect((caught as IpcInvokeError).remoteName).toBe("MalformedIpcResult");
  });

  it("isIpcResult 接受合法信封、拒绝非法形状", () => {
    expect(isIpcResult(okResult(1))).toBe(true);
    expect(isIpcResult(errResult("a:b", new Error("x")))).toBe(true);

    expect(isIpcResult(null)).toBe(false);
    expect(isIpcResult(undefined)).toBe(false);
    expect(isIpcResult("ok")).toBe(false);
    expect(isIpcResult({})).toBe(false);
    expect(isIpcResult({ ok: true })).toBe(false);
    expect(isIpcResult({ ok: false })).toBe(false);
    expect(isIpcResult({ ok: false, error: null })).toBe(false);
    expect(isIpcResult({ ok: false, error: { channel: "a:b" } })).toBe(false);
  });
});
