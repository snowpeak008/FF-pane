/**
 * 窗口覆盖的模型名。思考强度沿用既有档位。
 * 模型白名单：去掉首尾空白后，不能是空的，不能含换行或其它控制字符，
 * 最多 128 个字符；只允许字母、数字和 . _ : @ / -，末尾可以有 [1m] 这类后缀。
 */

export const MODEL_OVERRIDE_MAX_CHARS = 128;

const MODEL_BODY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const MODEL_WITH_SUFFIX = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*\[[A-Za-z0-9]{1,16}\]$/;

function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

export function validateModelOverride(
  value: string,
): { readonly ok: true; readonly model: string } | { readonly ok: false; readonly error: string } {
  const model = value.trim();
  if (model === "") {
    return { ok: false, error: "模型名不能是空白。" };
  }
  if (hasControlChar(model)) {
    return { ok: false, error: "模型名不能包含换行或控制字符。" };
  }
  if ([...model].length > MODEL_OVERRIDE_MAX_CHARS) {
    return { ok: false, error: "模型名太长（最多 128 个字符）。" };
  }
  if (!MODEL_BODY.test(model) && !MODEL_WITH_SUFFIX.test(model)) {
    return {
      ok: false,
      error: "模型名只能包含字母、数字和 . _ : @ / -，末尾可以有 [1m] 这类后缀。",
    };
  }
  return { ok: true, model };
}
