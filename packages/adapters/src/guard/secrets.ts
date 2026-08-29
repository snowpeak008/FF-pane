/**
 * 密钥注入的守门与事件文本兜底遮蔽（W2.7b 第 3 项）。
 *
 * ## 红线（设计文档 §4.3 / §4.4，本文件是它在适配器侧的唯一落点）
 * 1. **密钥只经 `AdapterTurnContext.env` 下发**。这是 W2.1a 约定的唯一通道：
 *    主进程 revealSecret 取明文 → 放入 env → process 层"清洗后注入"传给子进程。
 *    不得写入命令行参数（`ps` / 任务管理器可见）、不得写入配置文件、不得进提示词。
 * 2. **仅限本轮生命周期**。env 表随子进程结束消亡；guard 只在内存里持有值以供
 *    遮蔽，不持久化、不跨轮复用、不放进任何事件字段。
 * 3. **不入日志与事件**。适配器实现不得把 env 内容写进事件流；本模块的
 *    {@link maskGuardEvent} 是"万一还是漏出来了"的兜底——Runtime 可能把注入的
 *    环境变量回显进命令原文、命令输出、错误文本或原生事件里，那些文本会经 raw_log
 *    落盘（§6.4），故 guard 对所有透传事件的文本内容做密钥字面量替换。
 *
 * 兜底不是许可：遮蔽只保证"已知的注入值"不出现在事件里，凡是能不把密钥交给
 * Runtime 的场景就不要交。
 *
 * 与 W1.5c 的 `redactSecret` 思路相同（明文字面量整体替换），此处自实现以避免
 * adapters → core 只为一个字符串函数产生运行期依赖；差别是本层按变量名给出占位
 * 标记，且对过短的值不做替换（见 {@link MIN_MASKED_SECRET_LENGTH}）。
 */

import type { PermissionRequestPayload } from "@ff-pane/shared";
import type { AgentEvent, RawEvent } from "../events/index.js";

/**
 * 参与字面量遮蔽的最小值长度。
 *
 * 短值（"1"、"true"、端口号之类）出现在正常文本里是常态，替换它们会把事件打成
 * 马赛克且毫无安全收益；真正的密钥没有短于 8 字符的。低于此长度的注入值只受
 * "唯一通道 + 仅限本轮"两条红线约束，不做文本遮蔽。
 */
export const MIN_MASKED_SECRET_LENGTH = 8;

/** 遮蔽后的占位标记（带变量名，便于排障；变量名本身不是秘密）。 */
export function guardSecretPlaceholder(name: string): string {
  return `【已遮蔽：${name}】`;
}

/** 一条遮蔽规则：注入变量名 + 其明文值。 */
interface SecretReplacer {
  readonly name: string;
  readonly value: string;
}

/**
 * 本轮的密钥注入表。
 *
 * `toJSON` 只吐变量名：这样 `JSON.stringify(guardedEnv)` 这类无心之举
 * （日志、IPC 序列化、错误快照）不会把明文带出去。
 */
export interface GuardedEnv {
  /** 直接作为 `AdapterTurnContext.env` 下发的表（键序稳定，值为明文）。 */
  readonly env: Readonly<Record<string, string>>;
  /** 传给 `GuardTurnContext.secrets` 的遮蔽用表（与 env 同内容）。 */
  readonly secrets: Readonly<Record<string, string>>;
  /** 注入的变量名（已排序，可安全入日志）。 */
  readonly names: readonly string[];
  /** 序列化保护：只暴露变量名。 */
  toJSON(): { readonly names: readonly string[] };
}

/**
 * 构造本轮的密钥注入表。空值变量被剔除（既无法遮蔽，注入空值也只会让 CLI
 * 误判为"已配置"）。返回值冻结，不可再改。
 */
export function buildGuardedEnv(secrets: Record<string, string>): GuardedEnv {
  const entries = Object.entries(secrets)
    .filter(([, value]) => value !== "")
    .sort(([a], [b]) => a.localeCompare(b));
  const table: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(entries));
  const names: readonly string[] = Object.freeze(entries.map(([name]) => name));
  return Object.freeze({
    env: table,
    secrets: table,
    names,
    toJSON: () => ({ names }),
  });
}

function replacersOf(
  secrets: Readonly<Record<string, string>> | undefined,
): readonly SecretReplacer[] {
  if (secrets === undefined) {
    return [];
  }
  return (
    Object.entries(secrets)
      .filter(([, value]) => value.length >= MIN_MASKED_SECRET_LENGTH)
      // 长值优先：短值可能是长值的子串，先替换长的才不会留下残片。
      .sort(([, a], [, b]) => b.length - a.length)
      .map(([name, value]) => ({ name, value }))
  );
}

function applyReplacers(text: string, replacers: readonly SecretReplacer[]): string {
  let masked = text;
  for (const { name, value } of replacers) {
    if (masked.includes(value)) {
      masked = masked.split(value).join(guardSecretPlaceholder(name));
    }
  }
  return masked;
}

/** 把文本里出现的注入值全部替换为占位标记（供适配器外的诊断文本复用）。 */
export function maskGuardText(
  text: string,
  secrets: Readonly<Record<string, string>> | undefined,
): string {
  return applyReplacers(text, replacersOf(secrets));
}

/** 深度上限：原生事件可以嵌套，但没有理由深到 12 层，超出即原样保留。 */
const MAX_MASK_DEPTH = 12;

/** 递归遮蔽任意原生值（`RawEvent.native` 可能是任意 JSON 值或原始行文本）。 */
function maskUnknown(value: unknown, replacers: readonly SecretReplacer[], depth: number): unknown {
  if (typeof value === "string") {
    return applyReplacers(value, replacers);
  }
  if (depth >= MAX_MASK_DEPTH || typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskUnknown(item, replacers, depth + 1));
  }
  const masked: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    masked[key] = maskUnknown(item, replacers, depth + 1);
  }
  return masked;
}

function maskPayload(
  payload: PermissionRequestPayload,
  mask: (text: string) => string,
): PermissionRequestPayload {
  switch (payload.kind) {
    case "read_path": {
      const path = mask(payload.path);
      return path === payload.path ? payload : { kind: "read_path", path };
    }
    case "write_path": {
      const path = mask(payload.path);
      return path === payload.path ? payload : { kind: "write_path", path };
    }
    case "shell_command": {
      const command = mask(payload.command);
      return command === payload.command ? payload : { kind: "shell_command", command };
    }
    case "network": {
      if (payload.target === undefined) {
        return payload;
      }
      const target = mask(payload.target);
      return target === payload.target ? payload : { kind: "network", target };
    }
    case "dangerous_operation": {
      const detail = mask(payload.detail);
      return detail === payload.detail
        ? payload
        : { kind: "dangerous_operation", operation: payload.operation, detail };
    }
  }
}

function maskRaw(event: RawEvent, replacers: readonly SecretReplacer[]): RawEvent {
  const native = maskUnknown(event.native, replacers, 0);
  const note = event.note === undefined ? undefined : applyReplacers(event.note, replacers);
  if (native === event.native && note === event.note) {
    return event;
  }
  return { ...event, native, ...(note === undefined ? {} : { note }) };
}

/**
 * 对一条透传事件做密钥字面量遮蔽。无可遮蔽项时返回原对象（引用相等），
 * 故无密钥注入的 Run 上此函数近乎零成本。
 */
export function maskGuardEvent(
  event: AgentEvent,
  secrets: Readonly<Record<string, string>> | undefined,
): AgentEvent {
  const replacers = replacersOf(secrets);
  if (replacers.length === 0) {
    return event;
  }
  const mask = (text: string): string => applyReplacers(text, replacers);
  switch (event.kind) {
    case "session_start":
      return event;
    case "text": {
      const content = mask(event.content);
      return content === event.content ? event : { ...event, content };
    }
    case "file_change": {
      const path = mask(event.path);
      const diff = event.diff === undefined ? undefined : mask(event.diff);
      if (path === event.path && diff === event.diff) {
        return event;
      }
      return { ...event, path, ...(diff === undefined ? {} : { diff }) };
    }
    case "command": {
      const command = mask(event.command);
      const output = event.output === undefined ? undefined : mask(event.output);
      if (command === event.command && output === event.output) {
        return event;
      }
      return { ...event, command, ...(output === undefined ? {} : { output }) };
    }
    case "permission_request": {
      const payload = maskPayload(event.payload, mask);
      const reason = event.reason === undefined ? undefined : mask(event.reason);
      const diff = event.diff === undefined ? undefined : mask(event.diff);
      if (payload === event.payload && reason === event.reason && diff === event.diff) {
        return event;
      }
      return {
        ...event,
        payload,
        ...(reason === undefined ? {} : { reason }),
        ...(diff === undefined ? {} : { diff }),
      };
    }
    case "end": {
      if (event.message === undefined) {
        return event;
      }
      const message = mask(event.message);
      return message === event.message ? event : { ...event, message };
    }
    case "raw":
      return maskRaw(event, replacers);
  }
}
