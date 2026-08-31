/**
 * 知识库工具逐轮装配与审计回读单测（T6.6）。
 * 覆盖：内置 sidecar 启动方式、用户覆盖 command/args/env、路径始终注入、
 * 审计 JSONL 容错（缺文件 / 半行 / 坏行 / 空文件）。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { KnowledgeQueryRecord } from "@ff-pane/shared";
import { DEFAULT_KNOWLEDGE_TOOL_SERVER_NAME } from "@ff-pane/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createKnowledgeAuditPath,
  ENV_KNOWLEDGE_AUDIT,
  ENV_KNOWLEDGE_DB,
  KNOWLEDGE_MCP_SCRIPT,
  readKnowledgeAudit,
  resolveKnowledgeMcpServer,
} from "../src/main/session/knowledge-tool";

const BASE = {
  moduleDir: "/app/out/main",
  indexDbFile: "/root/.aiworkbench/index.sqlite",
  auditPath: "/tmp/audit/queries.jsonl",
};

describe("resolveKnowledgeMcpServer", () => {
  it("缺省用内置 sidecar：应用自身以 node 模式跑，不要求用户机器装有 node", () => {
    const { serverName, spec } = resolveKnowledgeMcpServer(BASE);
    expect(serverName).toBe(DEFAULT_KNOWLEDGE_TOOL_SERVER_NAME);
    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual([join("/app/out/main", KNOWLEDGE_MCP_SCRIPT)]);
    expect(spec.env?.["ELECTRON_RUN_AS_NODE"]).toBe("1");
  });

  it("索引库与审计路径始终注入（它们是本轮事实，不是配置项）", () => {
    const { spec } = resolveKnowledgeMcpServer(BASE);
    expect(spec.env?.[ENV_KNOWLEDGE_DB]).toBe(BASE.indexDbFile);
    expect(spec.env?.[ENV_KNOWLEDGE_AUDIT]).toBe(BASE.auditPath);
  });

  it("只预放行只读检索一个工具", () => {
    expect(resolveKnowledgeMcpServer(BASE).spec.allowedTools).toEqual(["knowledge_search"]);
  });

  it("用户覆盖 command → 用它，且不再塞 ELECTRON_RUN_AS_NODE", () => {
    const { spec } = resolveKnowledgeMcpServer({
      ...BASE,
      settings: { command: "python", args: ["-m", "my_server"] },
    });
    expect(spec.command).toBe("python");
    expect(spec.args).toEqual(["-m", "my_server"]);
    expect(spec.env?.["ELECTRON_RUN_AS_NODE"]).toBeUndefined();
    // 路径仍然注入：换了服务端实现也得知道去哪儿读索引
    expect(spec.env?.[ENV_KNOWLEDGE_DB]).toBe(BASE.indexDbFile);
  });

  it("用户覆盖 serverName", () => {
    const { serverName } = resolveKnowledgeMcpServer({
      ...BASE,
      settings: { serverName: "my-kb" },
    });
    expect(serverName).toBe("my-kb");
  });

  it("用户 env 追加项可覆盖默认（放最后合并）", () => {
    const { spec } = resolveKnowledgeMcpServer({
      ...BASE,
      settings: { env: { [ENV_KNOWLEDGE_AUDIT]: "/elsewhere.jsonl", EXTRA: "1" } },
    });
    expect(spec.env?.[ENV_KNOWLEDGE_AUDIT]).toBe("/elsewhere.jsonl");
    expect(spec.env?.["EXTRA"]).toBe("1");
  });

  it("只给 args 不给 command → 仍走内置（args 单独覆盖内置启动方式没有意义）", () => {
    const { spec } = resolveKnowledgeMcpServer({ ...BASE, settings: { args: ["--x"] } });
    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual([join("/app/out/main", KNOWLEDGE_MCP_SCRIPT)]);
  });
});

describe("readKnowledgeAudit", () => {
  let dir: string;
  let auditPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ff-pane-audit-test-"));
    auditPath = join(dir, "queries.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function record(query: string): KnowledgeQueryRecord {
    return {
      calledAt: 1,
      query,
      limit: 8,
      hits: [],
      usedFts: true,
      usedVector: false,
      durationMs: 2,
    };
  }

  it("文件不存在 = 本轮一次没调用 → 空数组（不是抛错）", async () => {
    expect(await readKnowledgeAudit(auditPath)).toEqual([]);
  });

  it("空文件 → 空数组", async () => {
    await writeFile(auditPath, "", "utf8");
    expect(await readKnowledgeAudit(auditPath)).toEqual([]);
  });

  it("逐行解析，保持调用顺序", async () => {
    const lines = [record("a"), record("b")].map((r) => JSON.stringify(r)).join("\n");
    await writeFile(auditPath, `${lines}\n`, "utf8");
    const read = await readKnowledgeAudit(auditPath);
    expect(read.map((r) => r.query)).toEqual(["a", "b"]);
  });

  it("最后一行写了一半（进程被杀）→ 跳过坏行，前面的照常读出", async () => {
    await writeFile(auditPath, `${JSON.stringify(record("good"))}\n{"query":"half`, "utf8");
    const read = await readKnowledgeAudit(auditPath);
    expect(read.map((r) => r.query)).toEqual(["good"]);
  });

  it("合法 JSON 但形状不对的行被丢弃，不污染 Run 记录", async () => {
    await writeFile(
      auditPath,
      `{"nope":1}\n${JSON.stringify(record("good"))}\n[1,2]\n"str"\n`,
      "utf8",
    );
    const read = await readKnowledgeAudit(auditPath);
    expect(read.map((r) => r.query)).toEqual(["good"]);
  });
});

describe("createKnowledgeAuditPath", () => {
  it("每轮一个独立目录，并发轮次不互相串写", async () => {
    const a = await createKnowledgeAuditPath();
    const b = await createKnowledgeAuditPath();
    expect(a).not.toBe(b);
    await rm(join(a, ".."), { recursive: true, force: true });
    await rm(join(b, ".."), { recursive: true, force: true });
  });
});
