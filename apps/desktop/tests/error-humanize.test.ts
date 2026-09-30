/**
 * T9.2 ① 报错人话化：信封结构化扩展（envelope errResult / IpcInvokeError）+
 * 渲染层字段提取（toIpcErrorInfo）+ 错误翻译层（humanizeIpcError 纯函数）。
 *
 * 向后兼容是硬要求：无 code / 未知 code 的错误必须回退现状显示（message 原文），
 * 本文件对回退路径与结构化路径各有钉子。
 */

import { describe, expect, it } from "vitest";
import { toIpcErrorInfo } from "../src/renderer/src/ipc/errors";
import { type ErrorTranslate, humanizeIpcError } from "../src/renderer/src/ipc/humanize";
import { draftContainsSecretShape, looksLikeSecret } from "../src/renderer/src/lib/secret-shape";
import { errResult, IpcInvokeError } from "../src/shared-ipc/envelope";

/** 造一个带结构化字段的错误（storage ProviderValidationError 的形状，不 import 该包）。 */
function providerValidationError(): Error {
  const error = new Error("Provider 校验失败（字段 baseUrl）：必须是 http/https 形式的 URL");
  error.name = "ProviderValidationError";
  Object.assign(error, {
    code: "provider-validation",
    field: "baseUrl",
    reason: "必须是 http/https 形式的 URL",
  });
  return error;
}

/** 造一个带 violations 的错误（core ProfileValidationError 的形状）。 */
function profileValidationError(): Error {
  const error = new Error("Profile 校验失败（2 处违规）：model、defaultRole");
  error.name = "ProfileValidationError";
  Object.assign(error, {
    violations: [
      { field: "model", reason: "模型不在 Provider 的 models 中" },
      { field: "defaultRole", reason: "未知角色" },
    ],
  });
  return error;
}

describe("信封结构化扩展（envelope.errResult）", () => {
  it("携带 code / field / reason 过信封", () => {
    const result = errResult("providers:create", providerValidationError());
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("provider-validation");
    expect(result.error.field).toBe("baseUrl");
    expect(result.error.reason).toBe("必须是 http/https 形式的 URL");
  });

  it("携带 violations 过信封（形状不符的条目丢弃）", () => {
    const error = profileValidationError();
    Object.assign(error, {
      violations: [...(error as unknown as { violations: unknown[] }).violations, "bad-shape", 42],
    });
    const result = errResult("profiles:create", error);
    if (result.ok) {
      return;
    }
    expect(result.error.violations).toEqual([
      { field: "model", reason: "模型不在 Provider 的 models 中" },
      { field: "defaultRole", reason: "未知角色" },
    ]);
  });

  it("向后兼容：普通 Error 的信封形状与从前一致（无新增字段）", () => {
    const result = errResult("app:ping", new RangeError("out of range"));
    if (result.ok) {
      return;
    }
    expect(Object.keys(result.error).sort()).toEqual(["channel", "message", "name", "stack"]);
  });

  it("IpcInvokeError 透出结构化字段，toIpcErrorInfo 逐字段提取", () => {
    const envelope = errResult("providers:create", providerValidationError());
    if (envelope.ok) {
      return;
    }
    const thrown = new IpcInvokeError(envelope.error);
    expect(thrown.code).toBe("provider-validation");
    const info = toIpcErrorInfo(thrown, "providers:create");
    expect(info.code).toBe("provider-validation");
    expect(info.field).toBe("baseUrl");
    expect(info.reason).toBe("必须是 http/https 形式的 URL");
  });

  it("toIpcErrorInfo 提取 violations（结构化克隆后的普通对象同样可读）", () => {
    const envelope = errResult("profiles:create", profileValidationError());
    if (envelope.ok) {
      return;
    }
    // 模拟结构化克隆：普通对象（无原型链）
    const cloned = JSON.parse(JSON.stringify(new IpcInvokeError(envelope.error)));
    const info = toIpcErrorInfo(cloned, "profiles:create");
    expect(info.violations).toHaveLength(2);
    expect(info.violations?.[0]).toEqual({
      field: "model",
      reason: "模型不在 Provider 的 models 中",
    });
  });
});

describe("错误翻译层（humanizeIpcError 纯函数）", () => {
  /** 假翻译表：只登记 provider-validation 与两个字段。 */
  const translations: Record<string, string> = {
    "errors.codes.provider-validation": "Provider 配置未通过校验，请检查下列字段：",
    "errors.codes.ProfileValidationError": "Profile 配置未通过校验，请检查下列字段：",
    "errors.fields.baseUrl": "API 地址",
    "errors.fields.model": "模型",
  };
  const translate: ErrorTranslate = (key, params) => {
    if (key === "errors.fieldNote") {
      return `${String(params?.["field"])}：${String(params?.["reason"])}`;
    }
    if (key === "errors.fieldOnly") {
      return String(params?.["field"]);
    }
    return translations[key];
  };

  it("命中已知 code：概括 + 字段定位（字段名查表翻译）+ 技术详情保留原文", () => {
    const info = toIpcErrorInfo(
      new IpcInvokeError({
        channel: "providers:create",
        name: "ProviderValidationError",
        message: "Provider 校验失败（字段 baseUrl）：必须是 http/https 形式的 URL",
        code: "provider-validation",
        field: "baseUrl",
        reason: "必须是 http/https 形式的 URL",
      }),
    );
    const result = humanizeIpcError(info, translate);
    expect(result.translated).toBe(true);
    expect(result.summary).toBe("Provider 配置未通过校验，请检查下列字段：");
    expect(result.fieldNotes).toEqual(["API 地址：必须是 http/https 形式的 URL"]);
    expect(result.technicalDetail).toContain("Provider 校验失败（字段 baseUrl）");
  });

  it("violations 逐条翻译；未登记的字段名原样展示", () => {
    const info = toIpcErrorInfo(
      new IpcInvokeError({
        channel: "profiles:create",
        name: "ProfileValidationError",
        message: "Profile 校验失败（2 处违规）：model、defaultRole",
        code: "ProfileValidationError",
        violations: [
          { field: "model", reason: "模型不存在" },
          { field: "defaultRole", reason: "未知角色" },
        ],
      }),
    );
    const result = humanizeIpcError(info, translate);
    expect(result.translated).toBe(true);
    expect(result.fieldNotes).toEqual(["模型：模型不存在", "defaultRole：未知角色"]);
  });

  it("回退：未知 code → translated=false，summary = 原始 message（现状显示一字不变）", () => {
    const info = toIpcErrorInfo(new Error("some legacy failure"));
    const result = humanizeIpcError(info, translate);
    expect(result.translated).toBe(false);
    expect(result.summary).toBe("some legacy failure");
    expect(result.fieldNotes).toEqual([]);
  });

  it("回退：无任何结构化字段的字符串抛出物同样回退", () => {
    const info = toIpcErrorInfo("纯字符串异常");
    const result = humanizeIpcError(info, translate);
    expect(result.translated).toBe(false);
    expect(result.summary).toBe("纯字符串异常");
  });
});

describe("密钥形状检测（T9.2 ⑤，仅提示不拦截）", () => {
  it("常见前缀命中：sk- / Bearer / AIza / xai- / ghp_ / JWT", () => {
    expect(looksLikeSecret("sk-live-4f9aXXXXXXXX")).toBe(true);
    expect(looksLikeSecret("Authorization: Bearer abcdef123456789")).toBe(true);
    expect(looksLikeSecret("AIzaSyA1234567890abcdefg")).toBe(true);
    expect(looksLikeSecret("xai-abc123def456")).toBe(true);
    expect(looksLikeSecret("ghp_0123456789abcdef01")).toBe(true);
    expect(looksLikeSecret("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVP")).toBe(true);
  });

  it("正常值不误伤：名称 / URL / 模型 ID", () => {
    expect(looksLikeSecret("My DeepSeek Provider")).toBe(false);
    expect(looksLikeSecret("https://api.deepseek.com/v1")).toBe(false);
    expect(looksLikeSecret("deepseek-chat")).toBe(false);
    // 含 "key" 字样但不是密钥形状（T9.1 验收里的误伤面论证样例）
    expect(looksLikeSecret("turkey-provider")).toBe(false);
    expect(looksLikeSecret("https://example.com/v1?key=short")).toBe(false);
  });

  it("草案递归扫描：嵌套字段与数组里的密钥形状都能命中", () => {
    expect(
      draftContainsSecretShape({
        name: "ok name",
        models: [{ id: "sk-live-4f9aXXXXXXXX", label: "x", kind: "chat" }],
      }),
    ).toBe(true);
    expect(
      draftContainsSecretShape({
        name: "clean",
        baseUrl: "https://api.example.com/v1",
        models: [{ id: "chat-1", label: "Chat", kind: "chat" }],
      }),
    ).toBe(false);
  });
});
