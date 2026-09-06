/**
 * 工作台自配置工具的主进程侧单测（T9.1）：
 * - 装配（resolveConfigMcpServer / createConfigMailbox）与审计回读（readConfigAudit）；
 * - 草案中枢（createConfigDraftHub）：校验失败回传 / 确认 / 拒绝 / 超时三态 /
 *   轮次结束自动拒绝 / 落盘失败不了结草案。
 * 全部走真实临时目录的文件信箱（这正是 sidecar 与主进程之间的真实通道）。
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { ConfigToolCallRecord } from "@ff-pane/shared";
import { CONFIG_TOOL_DRAFT_PROVIDER, CONFIG_TOOL_NAMES } from "@ff-pane/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ConfigDraftHub,
  createConfigDraftHub,
  type PrepareDraftResult,
} from "../src/main/session/config-draft-hub";
import {
  CONFIG_MCP_SCRIPT,
  createConfigMailbox,
  ENV_CONFIG_AUDIT,
  ENV_CONFIG_MAILBOX,
  ENV_CONFIG_PROFILES,
  ENV_CONFIG_PROVIDERS,
  readConfigAudit,
  resolveConfigMcpServer,
} from "../src/main/session/config-tool";
import type { ConfigDraftResponseFile } from "../src/mcp/config-tool";
import type { SessionStreamEvent } from "../src/shared-ipc/contracts";

describe("resolveConfigMcpServer（装配）", () => {
  const MAILBOX = {
    mailboxDir: "/root/.aiworkbench/config-mailbox/turn-x",
    requestsDir: "/root/.aiworkbench/config-mailbox/turn-x/requests",
    responsesDir: "/root/.aiworkbench/config-mailbox/turn-x/responses",
    auditPath: "/root/.aiworkbench/config-mailbox/turn-x/audit.jsonl",
  };

  it("内置 sidecar：应用自身以 node 模式跑（无用户覆盖面——见模块头论证）", () => {
    const spec = resolveConfigMcpServer({
      moduleDir: "/app/out/main",
      mailbox: MAILBOX,
      providersFile: "/root/.aiworkbench/providers.json",
      profilesFile: "/root/.aiworkbench/profiles.json",
    });
    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual([join("/app/out/main", CONFIG_MCP_SCRIPT)]);
    expect(spec.env?.["ELECTRON_RUN_AS_NODE"]).toBe("1");
    expect(spec.env?.[ENV_CONFIG_MAILBOX]).toBe(MAILBOX.mailboxDir);
    expect(spec.env?.[ENV_CONFIG_PROVIDERS]).toBe("/root/.aiworkbench/providers.json");
    expect(spec.env?.[ENV_CONFIG_PROFILES]).toBe("/root/.aiworkbench/profiles.json");
    expect(spec.env?.[ENV_CONFIG_AUDIT]).toBe(MAILBOX.auditPath);
  });

  it("四个工具全部预放行（list 无副作用；draft 的副作用被确认对话框物理拦住）", () => {
    const spec = resolveConfigMcpServer({
      moduleDir: "/m",
      mailbox: MAILBOX,
      providersFile: "/p.json",
      profilesFile: "/f.json",
    });
    expect(spec.allowedTools).toEqual([...CONFIG_TOOL_NAMES]);
  });

  it("env 不含任何密钥类内容（铁律 1：MCP env 会进命令行/配置文件，见 McpStdioServerSpec）", () => {
    const spec = resolveConfigMcpServer({
      moduleDir: "/m",
      mailbox: MAILBOX,
      providersFile: "/p.json",
      profilesFile: "/f.json",
    });
    for (const key of Object.keys(spec.env ?? {})) {
      expect(/secret|token|password|api.?key/i.test(key)).toBe(false);
    }
  });
});

describe("readConfigAudit（容错口径照 readKnowledgeAudit）", () => {
  let dir: string;
  let auditPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ff-pane-config-audit-"));
    auditPath = join(dir, "audit.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function record(summary: string, calledAt: number): ConfigToolCallRecord {
    return { calledAt, tool: "config_list_providers", summary, outcome: "ok", durationMs: 1 };
  }

  it("文件不存在 = 一次没调用 → 空数组", async () => {
    expect(await readConfigAudit(auditPath)).toEqual([]);
  });

  it("两个写者交错落笔 → 按 calledAt 升序归并（Run 合同要求时间升序）", async () => {
    const lines = [record("b", 20), record("a", 10)].map((r) => JSON.stringify(r)).join("\n");
    await writeFile(auditPath, `${lines}\n`, "utf8");
    const read = await readConfigAudit(auditPath);
    expect(read.map((r) => r.summary)).toEqual(["a", "b"]);
  });

  it("半行与形状不符的行被跳过", async () => {
    await writeFile(
      auditPath,
      `${JSON.stringify(record("good", 1))}\n{"tool":"half\n{"nope":1}\n`,
      "utf8",
    );
    expect((await readConfigAudit(auditPath)).map((r) => r.summary)).toEqual(["good"]);
  });
});

describe("createConfigDraftHub（草案流转三态 + 校验回传）", () => {
  let root: string;
  let requestsDir: string;
  let responsesDir: string;
  let auditPath: string;
  let published: SessionStreamEvent[];
  let hub: ConfigDraftHub | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ff-pane-config-hub-"));
    const mailbox = await createConfigMailbox(root);
    requestsDir = mailbox.requestsDir;
    responsesDir = mailbox.responsesDir;
    auditPath = mailbox.auditPath;
    published = [];
  });

  afterEach(async () => {
    await hub?.dispose();
    hub = undefined;
    await rm(root, { recursive: true, force: true });
  });

  const PROVIDER_ARGS = {
    name: "DeepSeek",
    type: "openai_compatible",
    baseUrl: "https://api.deepseek.com/v1",
    models: [{ id: "deepseek-chat", displayName: "Chat", kind: "chat" }],
    defaultModel: "deepseek-chat",
  };

  function makeHub(opts: {
    readonly prepare?: (parsed: unknown) => Promise<PrepareDraftResult>;
    readonly apply?: () => Promise<string>;
    readonly confirmTimeoutMs?: number;
  }): ConfigDraftHub {
    const created = createConfigDraftHub({
      turnId: "turn-1",
      requestsDir,
      responsesDir,
      auditPath,
      publish: (event) => published.push(event),
      prepare:
        (opts.prepare as never) ??
        (async (parsed) => ({ ok: true, normalized: parsed, needsApiKey: false })),
      apply: opts.apply ?? (async () => "provider-new"),
      now: () => Date.now(),
      ...(opts.confirmTimeoutMs !== undefined ? { confirmTimeoutMs: opts.confirmTimeoutMs } : {}),
      pollIntervalMs: 20,
    });
    created.start();
    hub = created;
    return created;
  }

  /** 把一份草案请求投进信箱（模拟 sidecar 的原子写）。 */
  async function submit(id: string, args: Record<string, unknown>): Promise<void> {
    await writeFile(
      join(requestsDir, `${id}.json`),
      JSON.stringify({ id, tool: CONFIG_TOOL_DRAFT_PROVIDER, args, at: Date.now() }),
      "utf8",
    );
  }

  /** 轮询等响应文件出现。 */
  async function awaitResponse(id: string, timeoutMs = 3_000): Promise<ConfigDraftResponseFile> {
    const path = join(responsesDir, `${id}.json`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        return JSON.parse(await readFile(path, "utf8")) as ConfigDraftResponseFile;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    throw new Error(`响应超时：${id}`);
  }

  /** 等 config-draft 事件出现（草案已推给渲染层）。 */
  async function awaitDraftEvent(
    timeoutMs = 3_000,
  ): Promise<Extract<SessionStreamEvent, { kind: "config-draft" }>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const event = published.find((e) => e.kind === "config-draft");
      if (event !== undefined) {
        return event as Extract<SessionStreamEvent, { kind: "config-draft" }>;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("config-draft 事件未出现");
  }

  it("校验失败 → invalid 响应原样回 Agent，不推确认事件（Agent 可修正重试）", async () => {
    makeHub({
      prepare: async () => ({ ok: false, error: "baseUrl 必须是 http/https" }),
    });
    await submit("d-invalid", PROVIDER_ARGS);
    const response = await awaitResponse("d-invalid");
    expect(response.outcome).toBe("invalid");
    expect(response.message).toContain("baseUrl");
    expect(published.some((e) => e.kind === "config-draft")).toBe(false);
    // 审计留 invalid 行
    const audit = await readConfigAudit(auditPath);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.outcome).toBe("invalid");
  });

  it("解析失败（密钥字样键）同样走 invalid——运行期兜住绕过 schema 的注入面", async () => {
    makeHub({});
    await submit("d-key", { ...PROVIDER_ARGS, apiKey: "sk-123" });
    const response = await awaitResponse("d-key");
    expect(response.outcome).toBe("invalid");
    expect(response.message).toContain("API keys are NEVER handled");
  });

  it("确认 → apply 落盘 → confirmed 响应带 resultId + 审计 + resolved 事件", async () => {
    const created = makeHub({ apply: async () => "provider-xyz" });
    await submit("d-ok", PROVIDER_ARGS);
    const event = await awaitDraftEvent();
    expect(event.summary).toBe('create provider "DeepSeek"');
    expect(event.needsApiKey).toBe(false);

    const ack = await created.respond({
      turnId: "turn-1",
      draftId: "d-ok",
      decision: "confirm",
    });
    expect(ack.ok).toBe(true);
    const response = await awaitResponse("d-ok");
    expect(response.outcome).toBe("confirmed");
    expect(response.resultId).toBe("provider-xyz");
    expect(published.some((e) => e.kind === "config-draft-resolved")).toBe(true);
    const audit = await readConfigAudit(auditPath);
    expect(audit[0]?.outcome).toBe("confirmed");
  });

  it("拒绝 → rejected 响应带原因（原样回 Agent）", async () => {
    const created = makeHub({});
    await submit("d-rej", PROVIDER_ARGS);
    await awaitDraftEvent();
    const ack = await created.respond({
      turnId: "turn-1",
      draftId: "d-rej",
      decision: "reject",
      reason: "换个便宜的模型",
    });
    expect(ack.ok).toBe(true);
    const response = await awaitResponse("d-rej");
    expect(response.outcome).toBe("rejected");
    expect(response.message).toBe("换个便宜的模型");
  });

  it("超时 → timeout 响应（口径：呈现给用户起算，超时不落盘）+ resolved 事件", async () => {
    makeHub({ confirmTimeoutMs: 100 });
    await submit("d-to", PROVIDER_ARGS);
    await awaitDraftEvent();
    const response = await awaitResponse("d-to");
    expect(response.outcome).toBe("timeout");
    expect((await readConfigAudit(auditPath))[0]?.outcome).toBe("timeout");
    expect(published.some((e) => e.kind === "config-draft-resolved")).toBe(true);
  });

  it("轮次结束（dispose）→ 未决草案自动拒绝", async () => {
    const created = makeHub({});
    await submit("d-end", PROVIDER_ARGS);
    await awaitDraftEvent();
    await created.dispose();
    const response = await awaitResponse("d-end");
    expect(response.outcome).toBe("rejected");
    expect(response.message).toContain("轮次已结束");
    const audit = await readConfigAudit(auditPath);
    expect(audit[0]?.outcome).toBe("rejected");
  });

  it("apply 落盘失败 → ack 带原因、草案不了结（用户可改密钥重试或改为拒绝）", async () => {
    let attempts = 0;
    const created = makeHub({
      apply: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("apiKeyRef 必填");
        }
        return "provider-2nd";
      },
    });
    await submit("d-retry", PROVIDER_ARGS);
    await awaitDraftEvent();

    const first = await created.respond({
      turnId: "turn-1",
      draftId: "d-retry",
      decision: "confirm",
    });
    expect(first.ok).toBe(false);
    expect(first.message).toContain("apiKeyRef");
    // 未了结：响应文件不存在
    await expect(readFile(join(responsesDir, "d-retry.json"), "utf8")).rejects.toThrow();

    const second = await created.respond({
      turnId: "turn-1",
      draftId: "d-retry",
      decision: "confirm",
    });
    expect(second.ok).toBe(true);
    expect((await awaitResponse("d-retry")).outcome).toBe("confirmed");
  });

  it("回执一份不存在的草案 → ok=false 且不写任何响应", async () => {
    const created = makeHub({});
    const ack = await created.respond({ turnId: "turn-1", draftId: "ghost", decision: "confirm" });
    expect(ack.ok).toBe(false);
    expect(await readdir(responsesDir)).toEqual([]);
  });
});
