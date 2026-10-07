/**
 * 管理者改窗口的模型 / 思考强度（T10.12b，§9.9）。
 * 覆盖记在窗口布局上。空闲时自动续接；忙则排队；不往终端写命令。
 */

import { isDescendantOf, type WorkbenchAuthNode } from "@ff-pane/core";
import {
  normalizeReasoningEffort,
  type ReasoningEffortLevel,
  validateModelOverride,
  type WorkbenchRole,
  type WorkbenchWindow,
} from "@ff-pane/shared";
import type { DeliverPhase } from "./idle-deliver";

export const MODEL_EFFORT_AUTO_MESSAGE = "已排队，空闲时自动续接";
export const MODEL_EFFORT_CONFIRM_MESSAGE = "等用户确认";
export const MODEL_EFFORT_DEFERRED_MESSAGE = "无法续接，待下次重启";

const DESCENDANT_ROLES: readonly WorkbenchRole[] = [
  "planner",
  "worker",
  "reviewer",
  "supervisor",
  "none",
];

export type ModelEffortOutcome = "queued" | "confirm" | "deferred";

export type ModelEffortReason = "busy" | "confirm" | "not-running" | "no-session" | "failed";

export type ModelEffortAction = "resume" | "confirm" | "pending" | "clear";

export interface ModelEffortFacts {
  readonly running: boolean;
  readonly phase: DeliverPhase;
  readonly canResume: boolean;
  readonly needsConfirm: boolean;
}

export interface ModelEffortDecision {
  readonly outcome: ModelEffortOutcome;
  readonly message: string;
  readonly reason: ModelEffortReason;
  readonly launch: boolean;
}

export function canSetModelEffort(input: {
  readonly callerId: string;
  readonly callerGranted: boolean;
  readonly targetId: string;
  readonly targetRole: WorkbenchRole;
  readonly tree: Readonly<Record<string, WorkbenchAuthNode>>;
}): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  if (!input.callerGranted || input.tree[input.callerId]?.role !== "manager") {
    return { ok: false, error: "只有管理者能改模型和思考强度。" };
  }
  if (input.tree[input.targetId] === undefined) {
    return { ok: false, error: "找不到这个窗口。" };
  }
  if (input.targetId === input.callerId) {
    return { ok: true };
  }
  if (input.targetRole === "manager") {
    return { ok: false, error: "不能改别的管理者的模型和思考强度。" };
  }
  if (
    !isDescendantOf(input.callerId, input.targetId, input.tree) ||
    !DESCENDANT_ROLES.includes(input.targetRole)
  ) {
    return {
      ok: false,
      error: "只能改自己，或自己后代里的写计划、执行、监管者、检查、普通窗口。",
    };
  }
  return { ok: true };
}

export function parseModelEffortArgs(args: {
  readonly model: unknown;
  readonly reasoningEffort: unknown;
}):
  | {
      readonly ok: true;
      readonly model?: string;
      readonly reasoningEffort?: ReasoningEffortLevel;
    }
  | { readonly ok: false; readonly error: string } {
  const hasModel = args.model !== undefined;
  const hasEffort = args.reasoningEffort !== undefined;
  if (!hasModel && !hasEffort) {
    return { ok: false, error: "请至少填写模型或思考强度。" };
  }
  let model: string | undefined;
  if (hasModel) {
    if (typeof args.model !== "string") {
      return { ok: false, error: "模型名必须是文字。" };
    }
    const parsed = validateModelOverride(args.model);
    if (!parsed.ok) {
      return parsed;
    }
    model = parsed.model;
  }
  let reasoningEffort: ReasoningEffortLevel | undefined;
  if (hasEffort) {
    if (typeof args.reasoningEffort !== "string") {
      return { ok: false, error: "思考强度必须是文字。" };
    }
    const level = normalizeReasoningEffort(args.reasoningEffort);
    if (level === undefined) {
      return {
        ok: false,
        error: "思考强度只能是 none、minimal、low、medium、high、xhigh、max。",
      };
    }
    reasoningEffort = level;
  }
  return {
    ok: true,
    ...(model !== undefined ? { model } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
}

export function decideModelEffort(facts: ModelEffortFacts): ModelEffortDecision {
  if (!facts.running) {
    return {
      outcome: "deferred",
      message: MODEL_EFFORT_DEFERRED_MESSAGE,
      reason: "not-running",
      launch: false,
    };
  }
  if (!facts.canResume) {
    return {
      outcome: "deferred",
      message: MODEL_EFFORT_DEFERRED_MESSAGE,
      reason: "no-session",
      launch: false,
    };
  }
  if (facts.phase !== "idle") {
    return {
      outcome: "queued",
      message: MODEL_EFFORT_AUTO_MESSAGE,
      reason: "busy",
      launch: false,
    };
  }
  if (facts.needsConfirm) {
    return {
      outcome: "confirm",
      message: MODEL_EFFORT_CONFIRM_MESSAGE,
      reason: "confirm",
      launch: false,
    };
  }
  return {
    outcome: "queued",
    message: MODEL_EFFORT_AUTO_MESSAGE,
    reason: "busy",
    launch: true,
  };
}

export function withModelEffortOverrides<
  T extends { readonly model?: string; readonly reasoningEffort?: string },
>(
  route: T,
  window: { readonly modelOverride?: string; readonly effortOverride?: string } | undefined,
): Omit<T, "model" | "reasoningEffort"> & {
  readonly model?: string;
  readonly reasoningEffort?: string;
} {
  const model =
    window?.modelOverride !== undefined && window.modelOverride.trim() !== ""
      ? window.modelOverride.trim()
      : route.model;
  const reasoningEffort =
    window?.effortOverride !== undefined && window.effortOverride.trim() !== ""
      ? window.effortOverride.trim()
      : route.reasoningEffort;
  const { model: _model, reasoningEffort: _effort, ...rest } = route;
  void _model;
  void _effort;
  return {
    ...rest,
    ...(model !== undefined && model.trim() !== "" ? { model } : {}),
    ...(reasoningEffort !== undefined && reasoningEffort.trim() !== "" ? { reasoningEffort } : {}),
  };
}

export function keepModelEffortOverrides(
  incoming: WorkbenchWindow,
  previous: WorkbenchWindow | undefined,
): WorkbenchWindow {
  if (previous === undefined) {
    return incoming;
  }
  const modelOverride = incoming.modelOverride ?? previous.modelOverride;
  const effortOverride = incoming.effortOverride ?? previous.effortOverride;
  if (modelOverride === undefined && effortOverride === undefined) {
    return incoming;
  }
  return {
    ...incoming,
    ...(modelOverride !== undefined ? { modelOverride } : {}),
    ...(effortOverride !== undefined ? { effortOverride } : {}),
  };
}

export interface ModelEffortNotice {
  readonly windowId: string;
  readonly action: ModelEffortAction;
  readonly reason: ModelEffortReason;
  readonly error?: string;
}

type SlotStatus = "queued" | "confirm" | "deferred" | "failed" | "resuming";

export interface ModelEffortSnapshot {
  readonly model?: string;
  readonly effort?: string;
}

interface Slot {
  status: SlotStatus;
  reason: ModelEffortReason;
  error?: string;
  generation: number;
  /** 续接已经开始之后又来了新值，等这次结束再续接一次。 */
  pendingFollowUp: boolean;
  model?: string;
  effort?: string;
}

export interface ModelEffortController {
  request(
    windowId: string,
    facts: ModelEffortFacts,
    snapshot?: ModelEffortSnapshot,
  ): ModelEffortDecision;
  /** 这次启动开始读布局之前的代数。读完后调用 noteLaunchRead。 */
  generation(windowId: string): number;
  /**
   * 启动参数已经从布局读出。
   * 若读取期间没有更新的请求，这次启动就是最新值，不再跟一次。
   * 读取期间又来了请求，则记下来，等这次结束后再续接一次。
   */
  noteLaunchRead(windowId: string, generationBeforeRead: number): ModelEffortSnapshot | undefined;
  onPossibleIdle(windowId: string, facts: ModelEffortFacts): void;
  drop(windowId: string): void;
  noteTerminalExit(windowId: string): void;
  settled(windowId: string, ok: boolean, error?: string): void;
}

export function createModelEffortController(deps: {
  readonly onChange: (notice: ModelEffortNotice) => void;
}): ModelEffortController {
  const slots = new Map<string, Slot>();

  const emit = (
    windowId: string,
    action: ModelEffortAction,
    reason: ModelEffortReason,
    error?: string,
  ): void => {
    deps.onChange({
      windowId,
      action,
      reason,
      ...(error !== undefined && error !== "" ? { error } : {}),
    });
  };

  const remember = (slot: Slot | undefined, snapshot: ModelEffortSnapshot | undefined): Slot => {
    return {
      status: slot?.status ?? "queued",
      reason: slot?.reason ?? "busy",
      generation: (slot?.generation ?? 0) + 1,
      pendingFollowUp: slot?.pendingFollowUp ?? false,
      ...(slot?.error !== undefined ? { error: slot.error } : {}),
      ...(snapshot?.model !== undefined
        ? { model: snapshot.model }
        : slot?.model !== undefined
          ? { model: slot.model }
          : {}),
      ...(snapshot?.effort !== undefined
        ? { effort: snapshot.effort }
        : slot?.effort !== undefined
          ? { effort: slot.effort }
          : {}),
    };
  };

  const snapshotOf = (slot: Slot): ModelEffortSnapshot => {
    return {
      ...(slot.model !== undefined ? { model: slot.model } : {}),
      ...(slot.effort !== undefined ? { effort: slot.effort } : {}),
    };
  };

  return {
    generation(windowId) {
      return slots.get(windowId)?.generation ?? 0;
    },
    noteLaunchRead(windowId, generationBeforeRead) {
      const slot = slots.get(windowId);
      if (slot === undefined || slot.status === "failed" || slot.status === "deferred") {
        return undefined;
      }
      slot.status = "resuming";
      slot.pendingFollowUp = slot.generation !== generationBeforeRead;
      return snapshotOf(slot);
    },
    request(windowId, facts, snapshot) {
      const decision = decideModelEffort(facts);
      const previous = slots.get(windowId);
      const next = remember(previous, snapshot);
      if (decision.launch) {
        if (previous?.status === "resuming") {
          slots.set(windowId, {
            ...next,
            status: "resuming",
            reason: "busy",
            pendingFollowUp: true,
          });
          return { ...decision, launch: false };
        }
        slots.set(windowId, {
          ...next,
          status: "resuming",
          reason: "busy",
          pendingFollowUp: false,
        });
        emit(windowId, "resume", "busy");
        return decision;
      }
      if (previous?.status === "resuming") {
        slots.set(windowId, { ...next, status: "resuming", pendingFollowUp: true });
        return { ...decision, launch: false, message: MODEL_EFFORT_AUTO_MESSAGE };
      }
      const status: SlotStatus =
        decision.outcome === "confirm"
          ? "confirm"
          : decision.outcome === "deferred"
            ? "deferred"
            : "queued";
      slots.set(windowId, { ...next, status, reason: decision.reason, pendingFollowUp: false });
      emit(windowId, decision.outcome === "confirm" ? "confirm" : "pending", decision.reason);
      return decision;
    },
    onPossibleIdle(windowId, facts) {
      const slot = slots.get(windowId);
      if (slot === undefined || slot.status !== "queued") {
        return;
      }
      const decision = decideModelEffort(facts);
      if (decision.launch) {
        slot.status = "resuming";
        slot.reason = "busy";
        slot.pendingFollowUp = false;
        emit(windowId, "resume", "busy");
        return;
      }
      if (decision.outcome === "confirm") {
        slot.status = "confirm";
        slot.reason = "confirm";
        emit(windowId, "confirm", "confirm");
      }
    },
    drop(windowId) {
      if (!slots.has(windowId)) {
        return;
      }
      slots.delete(windowId);
      emit(windowId, "clear", "busy");
    },
    noteTerminalExit(windowId) {
      const slot = slots.get(windowId);
      if (slot === undefined || slot.status === "resuming") {
        return;
      }
      slots.delete(windowId);
      emit(windowId, "clear", "busy");
    },
    settled(windowId, ok, error) {
      const slot = slots.get(windowId);
      if (slot === undefined) {
        if (!ok) {
          const message = error?.trim() || "续接失败";
          slots.set(windowId, {
            status: "failed",
            reason: "failed",
            error: message,
            generation: 0,
            pendingFollowUp: false,
          });
          emit(windowId, "pending", "failed", message);
        }
        return;
      }
      if (!ok) {
        const message = error?.trim() || "续接失败";
        slots.set(windowId, {
          ...slot,
          status: "failed",
          reason: "failed",
          error: message,
          pendingFollowUp: false,
        });
        emit(windowId, "pending", "failed", message);
        return;
      }
      if (slot.pendingFollowUp) {
        slot.pendingFollowUp = false;
        slot.status = "resuming";
        emit(windowId, "resume", "busy");
        return;
      }
      slots.delete(windowId);
      emit(windowId, "clear", "busy");
    },
  };
}
