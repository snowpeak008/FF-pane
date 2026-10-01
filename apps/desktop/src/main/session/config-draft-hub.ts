/**
 * 配置草案流转中枢（T9.1，Phase 9）：一轮一个实例，主进程侧的信箱消费者。
 *
 * 职责链（铁律 2 的机器形态）：
 * 轮询 `requests/` → 权威解析（mcp/config-tool 的纯解析器）→ 领域校验（注入的
 * prepare，复用 storage validateProviderDraft / core validateProfileDraft）→
 * 校验失败：写 invalid 响应原样回 Agent，可修正重试 →
 * 校验通过：推 `config-draft` 事件给渲染层确认对话框，起 5 分钟超时钟 →
 * 用户确认：注入的 apply 走既有 store 落盘（密钥经既有 safeStorage 通道），写
 * confirmed 响应 → 拒绝：写 rejected + 原因 → 超时：写 timeout →
 * 轮次结束（dispose）：未决草案自动拒绝。每一条草案的最终去向都追加进审计 JSONL
 * （与 sidecar 写的 list 行同一份文件，轮末由 readConfigAudit 归并回 Run）。
 *
 * **本模块没有任何绕过确认的路径**：apply 只在 respond({decision:"confirm"}) 的
 * 调用栈上可达，而那个调用只能来自渲染层确认对话框的 IPC 回执。
 *
 * 纯逻辑 + 注入依赖（校验/落盘/发布/时钟全部注入），可完整单测。
 */

import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ConfigToolCallRecord,
  ProfileId,
  ProjectConfig,
  ProjectConfigId,
  ProviderId,
} from "@ff-pane/shared";
import {
  CONFIG_TOOL_DRAFT_CONFIG,
  CONFIG_TOOL_DRAFT_PROFILE,
  CONFIG_TOOL_DRAFT_PROVIDER,
} from "@ff-pane/shared";
import {
  type ConfigDraftRequestFile,
  type ConfigDraftResponseFile,
  describeDraft,
  type ParsedConfigDraft,
  parseConfigDraftArgs,
  parseProfileDraftArgs,
  parseProviderDraftArgs,
  type SanitizedProviderView,
} from "../../mcp/config-tool";
import type {
  ConfigDraftAck,
  ConfigDraftPayload,
  RespondConfigDraftRequest,
  SessionStreamEvent,
} from "../../shared-ipc/contracts";
import { CONFIG_CONFIRM_TIMEOUT_MS } from "./config-tool";

/** 信箱轮询间隔（与 sidecar 侧对响应目录的轮询同数量级）。 */
export const DRAFT_POLL_INTERVAL_MS = 250;

/** 同时等用户确认的草案上限。多出来的直接拒绝，不进入确认框。 */
export const MAX_PENDING_CONFIG_DRAFTS = 3;

/** 领域校验 + 归一的结果。 */
export type PrepareDraftResult =
  | {
      readonly ok: true;
      /** 归一后的草案（如 Profile 预设哨兵已替换为全局默认），呈现与落盘都用它。 */
      readonly normalized: ParsedConfigDraft;
      /** 确认时是否需要用户补填密钥（Provider 草案且类型需 key 且无既有引用）。 */
      readonly needsApiKey: boolean;
      /** 更新目标的现状（已脱敏）。新建时缺省。确认框用它做差异。 */
      readonly current?: ProjectConfig | SanitizedProviderView;
    }
  | { readonly ok: false; readonly error: string };

/** 中枢依赖（校验与落盘的权威在宿主注入的既有 store，本模块不自带一套）。 */
export interface ConfigDraftHubDeps {
  /** 本轮 ID（事件路由键）。 */
  readonly turnId: string;
  /** sidecar 投递草案的目录。 */
  readonly requestsDir: string;
  /** 裁决结果写回的目录。 */
  readonly responsesDir: string;
  /** 审计 JSONL 路径（草案行由本中枢追加；list 行由 sidecar 追加）。 */
  readonly auditPath: string;
  /** 事件发布（config-draft / config-draft-resolved）。 */
  readonly publish: (event: SessionStreamEvent) => void;
  /** 领域校验 + 归一（复用 validateProviderDraft / validateProfileDraft，见 index.ts 接线）。 */
  readonly prepare: (parsed: ParsedConfigDraft) => Promise<PrepareDraftResult>;
  /**
   * 确认后的落盘（走既有 providers:create 同款通道；apiKey 为用户在对话框补填的明文，
   * 主进程加密后并进草稿——模型从头到尾不接触它）。返回落盘条目 ID；失败抛错。
   */
  readonly apply: (parsed: ParsedConfigDraft, apiKey?: string) => Promise<string>;
  readonly now: () => number;
  /** 用户确认超时（毫秒），缺省 CONFIG_CONFIRM_TIMEOUT_MS；单测注入小值。 */
  readonly confirmTimeoutMs?: number;
  /** 轮询间隔（毫秒），缺省 DRAFT_POLL_INTERVAL_MS。 */
  readonly pollIntervalMs?: number;
  readonly log?: (message: string) => void;
}

/** 中枢句柄（编排器经 ConfigToolBinding 消费）。 */
export interface ConfigDraftHub {
  /** 开始轮询信箱。 */
  start(): void;
  /** 渲染层回执一份草案的裁决。 */
  respond(request: RespondConfigDraftRequest): Promise<ConfigDraftAck>;
  /** 轮次收尾：未决草案自动拒绝、停止轮询。幂等。 */
  dispose(): Promise<void>;
}

/** 等待用户裁决中的一份草案。 */
interface PendingDraft {
  readonly id: string;
  readonly tool: string;
  readonly parsed: ParsedConfigDraft;
  /** 草案提交时刻（请求文件的 at；审计耗时的起点）。 */
  readonly submittedAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function createConfigDraftHub(deps: ConfigDraftHubDeps): ConfigDraftHub {
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? CONFIG_CONFIRM_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DRAFT_POLL_INTERVAL_MS;
  const seen = new Set<string>();
  const pending = new Map<string, PendingDraft>();
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  /** 处理串行链：轮询回调与 IPC 回执可能交错，逐件排队免并发写同一份响应。 */
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;

  function log(message: string): void {
    deps.log?.(`[config-tool] ${message}`);
  }

  /** 原子写响应文件（tmp + rename 语义由整文件一次写就近似——响应体积恒为数百字节）。 */
  async function writeResponse(response: ConfigDraftResponseFile): Promise<void> {
    try {
      await writeFile(
        join(deps.responsesDir, `${response.id}.json`),
        JSON.stringify(response),
        "utf8",
      );
    } catch (thrown) {
      log(`response write failed: ${String(thrown)}`);
    }
  }

  /** 审计追加（失败只记日志——审计是旁路证据，不该拖垮草案流转）。 */
  async function appendAudit(record: ConfigToolCallRecord): Promise<void> {
    try {
      await appendFile(deps.auditPath, `${JSON.stringify(record)}\n`, "utf8");
    } catch (thrown) {
      log(`audit write failed: ${String(thrown)}`);
    }
  }

  /** 一份草案的终局：写响应 + 审计 + 通知渲染层收对话框。 */
  async function settleDraft(
    draft: PendingDraft,
    outcome: "confirmed" | "rejected" | "timeout",
    options: { readonly message?: string; readonly resultId?: string },
  ): Promise<void> {
    clearTimeout(draft.timer);
    pending.delete(draft.id);
    await writeResponse({
      id: draft.id,
      outcome,
      ...(options.message !== undefined ? { message: options.message } : {}),
      ...(options.resultId !== undefined ? { resultId: options.resultId } : {}),
    });
    await appendAudit({
      calledAt: draft.submittedAt,
      tool: draft.tool,
      summary: describeDraft(draft.parsed),
      outcome,
      ...(options.message !== undefined ? { detail: options.message } : {}),
      durationMs: deps.now() - draft.submittedAt,
    });
    deps.publish({ turnId: deps.turnId, kind: "config-draft-resolved", draftId: draft.id });
  }

  /** 校验失败 / 解析失败的草案：invalid 响应原样回 Agent（不进用户视野）。 */
  async function rejectInvalid(request: ConfigDraftRequestFile, error: string): Promise<void> {
    await writeResponse({ id: request.id, outcome: "invalid", message: error });
    await appendAudit({
      calledAt: request.at,
      tool: request.tool,
      summary: `${request.tool} (rejected by validation)`,
      outcome: "invalid",
      detail: error,
      durationMs: deps.now() - request.at,
    });
  }

  /** 消化一份新草案（解析 → 校验 → 呈现给用户）。 */
  async function handleRequest(request: ConfigDraftRequestFile): Promise<void> {
    const parsed =
      request.tool === CONFIG_TOOL_DRAFT_PROVIDER
        ? parseProviderDraftArgs(request.args)
        : request.tool === CONFIG_TOOL_DRAFT_CONFIG
          ? parseConfigDraftArgs(request.args)
          : request.tool === CONFIG_TOOL_DRAFT_PROFILE
            ? parseProfileDraftArgs(request.args)
            : undefined;
    if (parsed === undefined) {
      await rejectInvalid(request, `Unknown draft tool: ${request.tool}`);
      return;
    }
    if (!parsed.ok) {
      await rejectInvalid(request, parsed.error);
      return;
    }
    let prepared: PrepareDraftResult;
    try {
      prepared = await deps.prepare(parsed.parsed);
    } catch (thrown) {
      prepared = { ok: false, error: thrown instanceof Error ? thrown.message : String(thrown) };
    }
    if (!prepared.ok) {
      await rejectInvalid(request, prepared.error);
      return;
    }
    if (pending.size >= MAX_PENDING_CONFIG_DRAFTS) {
      await rejectInvalid(
        request,
        `已有 ${MAX_PENDING_CONFIG_DRAFTS} 份草案在等确认。这份没有交给用户，也没有保存。`,
      );
      return;
    }

    const { normalized, needsApiKey, current } = prepared;
    const draft: PendingDraft = {
      id: request.id,
      tool: request.tool,
      parsed: normalized,
      submittedAt: request.at,
      // 超时钟从"推给渲染层"起算（口径见 CONFIG_CONFIRM_TIMEOUT_MS 注释）
      timer: setTimeout(() => {
        chain = chain.then(async () => {
          const still = pending.get(request.id);
          if (still !== undefined) {
            await settleDraft(still, "timeout", {});
          }
        });
      }, confirmTimeoutMs),
    };
    pending.set(request.id, draft);
    // 品牌 ID 在 JSON 边界收窄（工程约定）：草案的 id 来自 Agent 的字符串入参
    const payload: ConfigDraftPayload =
      normalized.kind === "provider"
        ? {
            kind: "provider",
            ...(normalized.id !== undefined ? { targetId: normalized.id as ProviderId } : {}),
            draft: normalized.draft,
            ...(current !== undefined && "apiKeyConfigured" in current ? { current } : {}),
          }
        : normalized.kind === "config"
          ? {
              kind: "config",
              ...(normalized.id !== undefined
                ? { targetId: normalized.id as ProjectConfigId }
                : {}),
              draft: normalized.draft,
              ...(current !== undefined && "isDefault" in current ? { current } : {}),
            }
          : {
              kind: "profile",
              ...(normalized.id !== undefined ? { targetId: normalized.id as ProfileId } : {}),
              draft: normalized.draft,
            };
    deps.publish({
      turnId: deps.turnId,
      kind: "config-draft",
      draftId: request.id,
      summary: describeDraft(normalized),
      payload,
      needsApiKey,
    });
  }

  /** 轮询一遍请求目录（新文件逐个消化；读失败按"下一轮再看"）。 */
  async function pollOnce(): Promise<void> {
    let names: readonly string[];
    try {
      names = await readdir(deps.requestsDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".tmp")) {
        continue;
      }
      const id = name.slice(0, -".json".length);
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      let request: ConfigDraftRequestFile;
      try {
        const text = await readFile(join(deps.requestsDir, name), "utf8");
        const raw: unknown = JSON.parse(text);
        if (
          typeof raw !== "object" ||
          raw === null ||
          typeof (raw as ConfigDraftRequestFile).id !== "string" ||
          typeof (raw as ConfigDraftRequestFile).tool !== "string"
        ) {
          continue;
        }
        request = raw as ConfigDraftRequestFile;
      } catch {
        // sidecar 是原子写（tmp + rename），读到半个 JSON 只可能是极端竞态：
        // 撤销 seen 标记，下一轮重读
        seen.delete(id);
        continue;
      }
      await handleRequest(request);
    }
  }

  return {
    start(): void {
      if (pollTimer !== undefined || disposed) {
        return;
      }
      pollTimer = setInterval(() => {
        chain = chain.then(() => pollOnce()).catch(() => undefined);
      }, pollIntervalMs);
    },

    async respond(request: RespondConfigDraftRequest): Promise<ConfigDraftAck> {
      // 排进串行链：与轮询 / 超时钟互斥，同一草案不会被两处同时了结
      let ack: ConfigDraftAck = { ok: false, message: "draft not pending" };
      chain = chain.then(async () => {
        const draft = pending.get(request.draftId);
        if (draft === undefined) {
          ack = { ok: false, message: "该草案已了结或不存在" };
          return;
        }
        if (request.decision === "reject") {
          await settleDraft(draft, "rejected", {
            ...(request.reason !== undefined && request.reason.trim().length > 0
              ? { message: request.reason.trim() }
              : {}),
          });
          ack = { ok: true };
          return;
        }
        // 确认：落盘走注入的既有通道。失败不了结草案——用户可修正（如重敲密钥）后重试，
        // 或显式拒绝；错误原文回给对话框。
        let resultId: string;
        try {
          resultId = await deps.apply(draft.parsed, request.apiKey);
        } catch (thrown) {
          ack = { ok: false, message: thrown instanceof Error ? thrown.message : String(thrown) };
          return;
        }
        await settleDraft(draft, "confirmed", { resultId });
        ack = { ok: true };
      });
      await chain;
      return ack;
    },

    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      // 未决草案自动拒绝（合同口径：轮次结束即收场，不留悬而未决）
      chain = chain.then(async () => {
        for (const draft of [...pending.values()]) {
          await settleDraft(draft, "rejected", { message: "轮次已结束，草案未获裁决，自动拒绝" });
        }
      });
      await chain;
    },
  };
}
