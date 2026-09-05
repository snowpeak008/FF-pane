/**
 * W2.6 OpenCode 适配器测试。
 *
 * 四层验证，全部不依赖本机是否装有 OpenCode：
 * 1. SSE 行协议解析器单测（跨 chunk 半行、CRLF、多行 data、心跳注释、截断尾块）；
 * 2. 事件映射器回放 T2.0 真实录制的 156 条 SSE（含权限请求与工具状态机），
 *    断言事件序列、callID 收敛、路径归一化、usage 累计；
 * 3. HTTP 客户端与 Server 生命周期：node:http 假服务 + 假 `serve` 子进程，
 *    验证健康检查、会话创建、权限回执（含新旧端点回退）、abort 的请求组装；
 * 4. 适配器端到端：假 OpenCode Server 上跑完整一轮（含权限批准与取消）。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { NativeSessionId } from "@ff-pane/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/events/index.js";
// 直接引子目录 barrel 而非包根 barrel：包根还会拉起同期并行工单的模块，
// 本工单的测试不该被邻居的暂态编译错误连坐（包根导出由 tsc 构建把关）。
import { splitLines } from "../src/events/index.js";
import type {
  OpenCodeClient,
  OpenCodeServer,
  OpenCodeServerStatus,
} from "../src/opencode/index.js";
import {
  createOpenCodeAdapter,
  createOpenCodeClient,
  createOpenCodeEventMapper,
  createOpenCodeServer,
  createSseDecoder,
  isSamePath,
  normalizeOpenCodePath,
  OPENCODE_CLI_FALLBACK_CAPABILITIES,
  OPENCODE_SERVER_CAPABILITIES,
  OpenCodeServerError,
  parseOpenCodeModel,
  readSseJsonRecords,
} from "../src/opencode/index.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/opencode/", import.meta.url));
/** 录制时的工作目录（fixture 中的绝对路径均以此为根）。 */
const FIXTURE_CWD = "C:\\Users\\REDACTED\\AppData\\Local\\Temp\\ffpane-oc\\proj";
const FIXTURE_SESSION = "ses_fb3353344ffeNaOCRu612L62J1";

async function readFixture(relative: string): Promise<string> {
  return readFile(join(FIXTURE_ROOT, relative), "utf8");
}

async function readSseFixture(): Promise<Record<string, unknown>[]> {
  const text = await readFixture("server/sse-events.jsonl");
  return splitLines(text)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function* fromChunks(
  chunks: readonly (string | Uint8Array)[],
): AsyncGenerator<string | Uint8Array> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe("SSE 行协议解析器", () => {
  it("跨 chunk 半行、CRLF、多行 data 与字段解析", () => {
    const decoder = createSseDecoder();
    const first = decoder.push('event: message\r\ndata: {"a":1}\r\n\r\nda');
    expect(first).toStrictEqual([{ event: "message", data: '{"a":1}' }]);

    const second = decoder.push("ta: line1\ndata: line2\nid: evt_1\n\n");
    expect(second).toStrictEqual([{ event: "message", data: "line1\nline2", id: "evt_1" }]);
  });

  it("忽略注释心跳与无 data 的空块，id 在后续事件中保持", () => {
    const decoder = createSseDecoder();
    expect(decoder.push(": ping\n\n")).toStrictEqual([]);
    expect(decoder.push("data: x\n\n")).toStrictEqual([{ event: "message", data: "x" }]);
  });

  it("data 值只剥一个前导空格，retry 与未知字段按规范处理", () => {
    const decoder = createSseDecoder();
    expect(decoder.push("retry: 1500\nfoo: bar\ndata:  两个空格\n\n")).toStrictEqual([
      { event: "message", data: " 两个空格", retry: 1500 },
    ]);
  });

  it("flush 派发未以空行收尾的尾块（abort 截断流不丢最后一条证据）", () => {
    const decoder = createSseDecoder();
    expect(decoder.push('data: {"type":"session.idle"}')).toStrictEqual([]);
    expect(decoder.flush()).toStrictEqual([{ event: "message", data: '{"type":"session.idle"}' }]);
  });

  it("readSseJsonRecords：合法载荷解析为对象，脏载荷走 InvalidJsonlLine 通道且不中断", async () => {
    const records = [];
    for await (const record of readSseJsonRecords(
      fromChunks(['data: {"type":"a"}\n\n', "data: 不是 JSON\n\n", 'data: {"type":"b"}\n\n']),
    )) {
      records.push(record);
    }
    expect(records.map((record) => record.ok)).toStrictEqual([true, false, true]);
    expect(records[0]?.ok === true ? records[0].value["type"] : undefined).toBe("a");
    expect(records[1]?.ok === false ? records[1].raw : undefined).toBe("不是 JSON");
  });
});

describe("路径归一化（Windows 三种形态并存）", () => {
  it("permission.asked 的无盘符 patterns 补回 cwd 的盘符", () => {
    expect(
      normalizeOpenCodePath(
        "Users\\REDACTED\\AppData\\Local\\Temp\\ffpane-oc\\proj\\hello.txt",
        FIXTURE_CWD,
      ),
    ).toBe(`${FIXTURE_CWD}\\hello.txt`);
  });

  it("metadata.filepath 的绝对路径原样保留（只消解 . 与 ..）", () => {
    expect(normalizeOpenCodePath(`${FIXTURE_CWD}\\sub\\..\\hello.txt`, FIXTURE_CWD)).toBe(
      `${FIXTURE_CWD}\\hello.txt`,
    );
    expect(normalizeOpenCodePath("/home/u/proj/a.txt", "/home/u/proj")).toBe("/home/u/proj/a.txt");
  });

  it("工具 input.filePath 的相对路径拼到 cwd 下", () => {
    expect(normalizeOpenCodePath("hello.txt", FIXTURE_CWD)).toBe(`${FIXTURE_CWD}\\hello.txt`);
    expect(normalizeOpenCodePath("./src/a.ts", "/home/u/proj")).toBe("/home/u/proj/src/a.ts");
  });

  it("与 cwd 无关的无盘符路径按相对路径处理，不误判为绝对", () => {
    expect(normalizeOpenCodePath("Windows\\System32\\x.dll", FIXTURE_CWD)).toBe(
      `${FIXTURE_CWD}\\Windows\\System32\\x.dll`,
    );
  });

  it("isSamePath：Windows 下忽略大小写与分隔符风格", () => {
    expect(isSamePath("C:\\Users\\A\\proj", "c:/users/a/proj/")).toBe(true);
    expect(isSamePath("C:\\Users\\A\\proj", "C:\\Users\\A\\other")).toBe(false);
    expect(isSamePath("/home/u/proj", "/home/U/proj")).toBe(false);
  });
});

describe("事件映射器（回放 156 条真实 SSE）", () => {
  it("完整事件序列：增量文本 → 定稿 → 权限 → 工具终态 → 恰好一条 end", async () => {
    const mapper = createOpenCodeEventMapper({ sessionId: FIXTURE_SESSION, cwd: FIXTURE_CWD });
    const events: AgentEvent[] = [];
    for (const native of await readSseFixture()) {
      events.push(...mapper.map(native));
    }

    const texts = events.filter((event) => event.kind === "text");
    // 录制里 28 条 delta + 3 条定稿（三轮各一条）。
    expect(texts.filter((event) => !event.final)).toHaveLength(28);
    expect(texts.filter((event) => event.final)).toHaveLength(3);
    // 已有增量的部件，定稿事件只作收尾信号，不重复正文（否则 UI 会渲染两遍）。
    expect(texts.filter((event) => event.final).every((event) => event.content === "")).toBe(true);
    expect(
      texts
        .filter((event) => !event.final)
        .slice(0, 3)
        .map((event) => event.content),
    ).toStrictEqual(["Hello!", " This", " is"]);

    // 工具状态机 pending→running→completed 三条 message.part.updated 只收敛出一条事件。
    const fileChanges = events.filter((event) => event.kind === "file_change");
    expect(fileChanges).toHaveLength(1);
    const [fileChange] = fileChanges;
    expect(fileChange).toMatchObject({
      kind: "file_change",
      path: `${FIXTURE_CWD}\\hello.txt`,
      changeKind: "add",
      status: "completed",
      actionId: "call_mock_02kz057r",
    });
    // completed 态本身没有 diff，按 callID 关联到此前 permission.asked 的 metadata.diff。
    expect(fileChange?.kind === "file_change" ? fileChange.diff : undefined).toContain(
      "+hello from FF-pane opencode probe",
    );

    const permissions = events.filter((event) => event.kind === "permission_request");
    expect(permissions).toHaveLength(1);
    expect(permissions[0]).toMatchObject({
      kind: "permission_request",
      nativeRequestId: "per_04ccad3020013jbMcwNJsjxC9Q",
      toolName: "edit",
      payload: { kind: "write_path", path: `${FIXTURE_CWD}\\hello.txt` },
    });

    const ends = events.filter((event) => event.kind === "end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ kind: "end", reason: "completed" });
    // 一轮结束前只累计了第一轮的 step-finish（132 = 120 + 12）。
    expect(ends[0]?.kind === "end" ? ends[0].usage : undefined).toStrictEqual({
      inputTokens: 120,
      outputTokens: 12,
      totalTokens: 132,
    });
    expect(mapper.hasEnded()).toBe(true);
  });

  it("启动噪声与用户提示词回显不产生事件", async () => {
    const mapper = createOpenCodeEventMapper({ sessionId: FIXTURE_SESSION, cwd: FIXTURE_CWD });
    const natives = await readSseFixture();
    const noise = natives.filter((event) =>
      [
        "plugin.added",
        "catalog.updated",
        "session.diff",
        "file.edited",
        "server.connected",
      ].includes(String(event["type"])),
    );
    expect(noise.length).toBeGreaterThan(40);
    expect(noise.flatMap((event) => mapper.map(event))).toStrictEqual([]);

    // 第 5 条是用户消息的 text 部件（提示词回显），必须先登记再判定。
    const userMessage = natives.find(
      (event) =>
        event["type"] === "message.updated" && JSON.stringify(event).includes('"role":"user"'),
    );
    expect(userMessage).toBeDefined();
    mapper.map(userMessage);
    const userPart = natives[4];
    expect(mapper.map(userPart)).toStrictEqual([]);
  });

  it("按 sessionID 过滤，带 parentID 的子 Agent 会话并入本轮", () => {
    const mapper = createOpenCodeEventMapper({ sessionId: "ses_root", cwd: FIXTURE_CWD });
    // 别的会话的事件整条丢弃。
    expect(
      mapper.map({
        type: "message.part.delta",
        properties: { sessionID: "ses_other", field: "text", delta: "x" },
      }),
    ).toStrictEqual([]);

    // 子会话尚未登记时同样被过滤。
    const childDelta = {
      type: "message.part.delta",
      properties: { sessionID: "ses_child", field: "text", delta: "子任务" },
    };
    expect(mapper.map(childDelta)).toStrictEqual([]);

    mapper.map({
      type: "session.created",
      properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: "ses_root" } },
    });
    expect(mapper.sessionIds.has("ses_child")).toBe(true);
    expect(mapper.map(childDelta)).toStrictEqual([
      { kind: "text", content: "子任务", final: false, channel: "answer" },
    ]);

    // 父不在集合内的子会话不并入。
    mapper.map({
      type: "session.created",
      properties: { info: { id: "ses_alien", parentID: "ses_stranger" } },
    });
    expect(mapper.sessionIds.has("ses_alien")).toBe(false);
  });

  it("bash 工具终态 → command 事件，退出码取 state.metadata.exit（run-json s5 真实 part）", async () => {
    const s5 = splitLines(await readFixture("run-json/s5-bash.jsonl"))
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event["type"] === "tool_use");
    expect(s5).toBeDefined();
    const part = (s5 as { part: Record<string, unknown> }).part;

    const mapper = createOpenCodeEventMapper({ sessionId: FIXTURE_SESSION, cwd: FIXTURE_CWD });
    const events = mapper.map({
      type: "message.part.updated",
      properties: { sessionID: FIXTURE_SESSION, part },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "command",
      command: "echo hello-ffpane",
      status: "completed",
      exitCode: 0,
    });

    // 同一 callID 的重复终态事件不再产生第二条（状态机收敛）。
    expect(
      mapper.map({
        type: "message.part.updated",
        properties: { sessionID: FIXTURE_SESSION, part },
      }),
    ).toStrictEqual([]);
  });

  it("权限被拒的工具错误落 denied 而不是 failed（run-json s3 真实 part）", async () => {
    const s3 = splitLines(await readFixture("run-json/s3-write-ask-reject.jsonl"))
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event["type"] === "tool_use");
    const part = (s3 as { part: Record<string, unknown> }).part;

    const mapper = createOpenCodeEventMapper({ sessionId: FIXTURE_SESSION, cwd: FIXTURE_CWD });
    const [event] = mapper.map({
      type: "message.part.updated",
      properties: { sessionID: FIXTURE_SESSION, part },
    });
    expect(event).toMatchObject({ kind: "file_change", status: "denied" });
  });

  it("permission.asked 缺 metadata.filepath 时回落 patterns 并归一化为绝对路径", async () => {
    const asked = JSON.parse(await readFixture("server/event-permission-asked.json")) as {
      properties: { metadata: Record<string, unknown> };
    };
    delete asked.properties.metadata["filepath"];
    const mapper = createOpenCodeEventMapper({ sessionId: FIXTURE_SESSION, cwd: FIXTURE_CWD });
    const [event] = mapper.map(asked);
    expect(event).toMatchObject({
      kind: "permission_request",
      payload: { kind: "write_path", path: `${FIXTURE_CWD}\\hello.txt` },
    });
  });

  it("bash 权限请求 → shell_command；未知权限名兜底为可审批的 shell_command", () => {
    const mapper = createOpenCodeEventMapper({ sessionId: "ses_root", cwd: FIXTURE_CWD });
    const [bash] = mapper.map({
      type: "permission.asked",
      properties: {
        id: "per_bash",
        sessionID: "ses_root",
        permission: "bash",
        patterns: ["rm -rf *"],
        metadata: { command: "rm -rf build" },
      },
    });
    expect(bash).toMatchObject({
      kind: "permission_request",
      payload: { kind: "shell_command", command: "rm -rf build" },
      toolName: "bash",
    });

    const [mcp] = mapper.map({
      type: "permission.asked",
      properties: {
        id: "per_mcp",
        sessionID: "ses_root",
        permission: "mcp_jira_create_issue",
        patterns: [],
        metadata: {},
      },
    });
    expect(mcp).toMatchObject({
      kind: "permission_request",
      nativeRequestId: "per_mcp",
      toolName: "mcp_jira_create_issue",
      payload: { kind: "shell_command", command: "mcp_jira_create_issue" },
    });
  });

  it("保活心跳静默丢弃，未知事件类型走 raw 通道留档", () => {
    const mapper = createOpenCodeEventMapper({ sessionId: "ses_root", cwd: FIXTURE_CWD });
    // server.heartbeat：1.18.25 真机每 10 秒一条，且不在 OpenAPI 的 Event schema 里。
    expect(mapper.map({ type: "server.heartbeat", properties: {} })).toStrictEqual([]);
    // 实验性新事件系统（session.next.*）不会被误当成正式输出，只留档。
    const [raw] = mapper.map({
      type: "session.next.text.delta",
      properties: { sessionID: "ses_root", delta: "x" },
    });
    expect(raw).toMatchObject({
      kind: "raw",
      runtime: "opencode",
      nativeType: "session.next.text.delta",
    });
  });

  it("session.error 直接落 end(failed)，脏载荷走 raw 通道", () => {
    const mapper = createOpenCodeEventMapper({ sessionId: "ses_root", cwd: FIXTURE_CWD });
    const [end] = mapper.map({
      type: "session.error",
      properties: {
        sessionID: "ses_root",
        error: { name: "APIError", data: { message: "Cannot connect to API" } },
      },
    });
    expect(end).toMatchObject({
      kind: "end",
      reason: "failed",
      message: "APIError: Cannot connect to API",
    });

    expect(mapper.map("不是对象")).toStrictEqual([
      { kind: "raw", runtime: "opencode", native: "不是对象", note: "SSE 事件载荷不是 JSON 对象" },
    ]);
  });

  it("非流式 Provider：没有 delta 的文本部件定稿时带上全文，不丢内容", () => {
    const mapper = createOpenCodeEventMapper({ sessionId: "ses_root", cwd: FIXTURE_CWD });
    const [event] = mapper.map({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_root",
        part: {
          id: "prt_1",
          messageID: "msg_1",
          type: "text",
          text: "整块到达的回答",
          time: { start: 1, end: 2 },
        },
      },
    });
    expect(event).toStrictEqual({
      kind: "text",
      content: "整块到达的回答",
      final: true,
      channel: "answer",
      messageId: "msg_1",
    });
  });

  it("parseOpenCodeModel：provider/model 切分与缺省 providerID", () => {
    expect(parseOpenCodeModel("deepseek/deepseek-chat", undefined)).toStrictEqual({
      providerID: "deepseek",
      modelID: "deepseek-chat",
    });
    expect(parseOpenCodeModel("deepseek-chat", "mycorp")).toStrictEqual({
      providerID: "mycorp",
      modelID: "deepseek-chat",
    });
    expect(parseOpenCodeModel("deepseek-chat", undefined)).toBeUndefined();
    expect(parseOpenCodeModel(undefined, "mycorp")).toBeUndefined();
  });
});

describe("能力声明", () => {
  it("Server 路径六项按调研 §7 如实填，CLI 降级路径显式区分", () => {
    expect(OPENCODE_SERVER_CAPABILITIES).toStrictEqual({
      nativeResume: "yes",
      streaming: "yes",
      fileChangeEvents: "yes",
      commandEvents: "yes",
      permissionForwarding: "yes",
      gracefulCancel: "yes",
    });
    expect(OPENCODE_CLI_FALLBACK_CAPABILITIES.streaming).toBe("partial");
    expect(OPENCODE_CLI_FALLBACK_CAPABILITIES.permissionForwarding).toBe("no");
    expect(OPENCODE_CLI_FALLBACK_CAPABILITIES.gracefulCancel).toBe("partial");
  });
});

/* ------------------------------------------------------------------ *
 * 假 OpenCode Server（node:http）：只实现适配器用到的端点。
 * ------------------------------------------------------------------ */

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly body: string;
  readonly headers: Record<string, string | undefined>;
}

interface FakeOpenCode {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  /** 向所有 SSE 订阅者推一条事件。 */
  emit(event: unknown): void;
  /** 等待某个请求到达（用于"提示词发出后再推事件"的编排）。 */
  waitFor(predicate: (request: RecordedRequest) => boolean): Promise<RecordedRequest>;
  close(): Promise<void>;
}

interface FakeOptions {
  /** 会话对象的 directory 字段（resume 校验用），缺省取请求里的 directory。 */
  readonly sessionDirectory?: string;
  /** 旧权限端点返回的状态码（用 404 触发新端点回退）。 */
  readonly legacyPermissionStatus?: number;
}

/**
 * WHATWG fetch 「坏端口」黑名单里落在动态端口范围内的那些：`listen(0)` 抽到其中之一时
 * 假服务照常在听，但 fetch 在建立连接之前就报 `fetch failed ← bad port`。
 * 根因与实测枚举见 `packages/core/tests/provider-probe.test.ts` 同名常量的注释。
 * 假 `serve` 子进程脚本（`FAKE_SERVE_SOURCE`）里另有一份同规则的实现。
 */
const FETCH_BAD_PORTS: ReadonlySet<number> = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

/** 绑定一个 fetch 真的到得了的本地端口（抽到黑名单上的端口就换一个再绑）。 */
async function listenOnFetchablePort(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    if (!FETCH_BAD_PORTS.has(port)) {
      return port;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  throw new Error("连续 64 次 listen(0) 都落在 fetch 坏端口上，无法起假服务");
}

async function startFakeOpenCode(options: FakeOptions = {}): Promise<FakeOpenCode> {
  const requests: RecordedRequest[] = [];
  const waiters: {
    predicate: (request: RecordedRequest) => boolean;
    resolve: (r: RecordedRequest) => void;
  }[] = [];
  const subscribers = new Set<ServerResponse>();

  function note(request: RecordedRequest): void {
    requests.push(request);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(request)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(request);
      }
    }
  }

  function json(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = req.url ?? "";
      const path = url.split("?")[0] ?? "";
      note({
        method: req.method ?? "",
        url,
        body: Buffer.concat(chunks).toString("utf8"),
        headers: { authorization: req.headers.authorization, accept: req.headers.accept },
      });

      if (path === "/global/health") {
        json(res, 200, { healthy: true, version: "9.9.9-fake" });
        return;
      }
      if (path === "/event") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
        subscribers.add(res);
        res.on("close", () => subscribers.delete(res));
        return;
      }
      if (path === "/session" && req.method === "POST") {
        const directory =
          options.sessionDirectory ?? decodeURIComponent(url.split("directory=")[1] ?? "");
        json(res, 200, { id: "ses_fake0001", directory, title: "fake" });
        return;
      }
      if (/^\/session\/[^/]+$/.test(path) && req.method === "GET") {
        const id = decodeURIComponent(path.split("/")[2] ?? "");
        if (id === "ses_missing") {
          json(res, 404, { message: "session not found" });
          return;
        }
        const directory =
          options.sessionDirectory ?? decodeURIComponent(url.split("directory=")[1] ?? "");
        json(res, 200, { id, directory });
        return;
      }
      if (path.endsWith("/prompt_async")) {
        res.writeHead(204).end();
        return;
      }
      if (path.includes("/permissions/")) {
        const status = options.legacyPermissionStatus ?? 200;
        if (status === 200) {
          json(res, 200, true);
        } else {
          json(res, status, { message: "gone" });
        }
        return;
      }
      if (/^\/permission\/[^/]+\/reply$/.test(path)) {
        json(res, 200, true);
        return;
      }
      if (path.endsWith("/abort")) {
        json(res, 200, true);
        return;
      }
      json(res, 404, { message: `未实现的端点 ${path}` });
    });
  });

  const port = await listenOnFetchablePort(server);

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    emit(event: unknown): void {
      for (const subscriber of subscribers) {
        subscriber.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    },
    waitFor(predicate): Promise<RecordedRequest> {
      const existing = requests.find(predicate);
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve) => {
        waiters.push({ predicate, resolve });
      });
    },
    async close(): Promise<void> {
      for (const subscriber of subscribers) {
        subscriber.end();
      }
      subscribers.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

describe("HTTP 客户端请求组装（node:http 假服务）", () => {
  let fake: FakeOpenCode;

  afterEach(async () => {
    await fake?.close();
  });

  it("健康检查 / 建会话（directory 走查询参数）/ prompt_async 请求体 / abort", async () => {
    fake = await startFakeOpenCode();
    const client = createOpenCodeClient({ baseUrl: fake.baseUrl, password: "pw" });

    expect(await client.health()).toStrictEqual({ healthy: true, version: "9.9.9-fake" });

    const session = await client.createSession({
      directory: "C:\\proj",
      title: "t",
      agent: "plan",
    });
    expect(session.id).toBe("ses_fake0001");
    const create = fake.requests.find((request) => request.url.startsWith("/session?"));
    expect(create?.url).toBe("/session?directory=C%3A%5Cproj");
    expect(JSON.parse(create?.body ?? "")).toStrictEqual({ title: "t", agent: "plan" });
    // basic auth 用户名固定为 opencode（1.18.25 实测，其他用户名一律 401）。
    expect(create?.headers.authorization).toBe(
      `Basic ${Buffer.from("opencode:pw").toString("base64")}`,
    );

    await client.promptAsync({
      sessionId: "ses_fake0001",
      text: "干活",
      directory: "C:\\proj",
      agent: "build",
      model: { providerID: "deepseek", modelID: "deepseek-chat" },
    });
    const prompt = fake.requests.find((request) => request.url.includes("prompt_async"));
    expect(prompt?.url).toBe("/session/ses_fake0001/prompt_async?directory=C%3A%5Cproj");
    expect(JSON.parse(prompt?.body ?? "")).toStrictEqual({
      parts: [{ type: "text", text: "干活" }],
      agent: "build",
      model: { providerID: "deepseek", modelID: "deepseek-chat" },
    });

    expect(await client.abort("ses_fake0001", "C:\\proj")).toBe(true);
    expect(fake.requests.some((request) => request.url.includes("/abort"))).toBe(true);
  });

  it("权限回执：主路径打 /session/:id/permissions/:id，deny → reject", async () => {
    fake = await startFakeOpenCode();
    const client = createOpenCodeClient({ baseUrl: fake.baseUrl });
    await client.respondPermission("ses_1", "per_1", "reject");
    const replied = fake.requests.find((request) => request.url.includes("/permissions/"));
    expect(replied?.url).toBe("/session/ses_1/permissions/per_1");
    expect(JSON.parse(replied?.body ?? "")).toStrictEqual({ response: "reject" });
  });

  it("旧权限端点被移除（404）时自动回退新端点 /permission/:id/reply", async () => {
    fake = await startFakeOpenCode({ legacyPermissionStatus: 404 });
    const client = createOpenCodeClient({ baseUrl: fake.baseUrl });
    await client.respondPermission("ses_1", "per_1", "once");
    const fallback = fake.requests.find((request) => request.url === "/permission/per_1/reply");
    expect(fallback).toBeDefined();
    expect(JSON.parse(fallback?.body ?? "")).toStrictEqual({ reply: "once" });
  });

  it("非 2xx 抛 OpenCodeHttpError 并带状态码", async () => {
    fake = await startFakeOpenCode();
    const client = createOpenCodeClient({ baseUrl: fake.baseUrl });
    await expect(client.getSession("ses_missing")).rejects.toMatchObject({
      name: "OpenCodeHttpError",
      status: 404,
    });
  });
});

/* ------------------------------------------------------------------ *
 * 假 `opencode serve` 子进程：验证端口公告解析、健康轮询、崩溃与关停。
 * ------------------------------------------------------------------ */

const FAKE_SERVE_SOURCE = `
import { createServer } from "node:http";
const server = createServer((req, res) => {
  if (req.url === "/global/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ healthy: true, version: "9.9.9-fake" }));
    return;
  }
  if (req.url === "/__crash") {
    res.writeHead(200).end("bye");
    process.exit(7);
    return;
  }
  res.writeHead(404).end();
});
// 只公告 fetch 可达的端口：WHATWG 坏端口黑名单上的端口会让健康检查的 fetch 在建立
// 连接之前就失败，见测试文件里 FETCH_BAD_PORTS 的注释。
const badPorts = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);
const listen = () => {
  server.listen(0, "127.0.0.1", () => {
    if (badPorts.has(server.address().port)) {
      server.close(listen);
      return;
    }
    if (process.env["FAKE_SERVE_SILENT"] === "1") return;
    console.log("opencode server listening on http://127.0.0.1:" + server.address().port);
  });
};
listen();
`;

describe("Server 生命周期（假 serve 子进程）", () => {
  let workDir: string;
  let scriptPath: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ff-pane-opencode-"));
    scriptPath = join(workDir, "fake-serve.mjs");
    await writeFile(scriptPath, FAKE_SERVE_SOURCE, "utf8");
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("从 stdout 公告解析监听地址、健康检查通过后转 ready 并记录版本", async () => {
    const server = createOpenCodeServer({
      command: process.execPath,
      leadingArgs: [scriptPath],
      healthIntervalMs: 20,
      readyTimeoutMs: 20_000,
    });
    try {
      const client = await server.ensureReady();
      expect(client.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const status = server.status();
      expect(status.state).toBe("ready");
      expect(status.version).toBe("9.9.9-fake");
      expect(status.pid).toBeGreaterThan(0);

      // 复用：再次 ensureReady 不重启，引用计数如实反映活跃轮次。
      expect(await server.ensureReady()).toBe(client);
      server.acquire();
      expect(server.status().activeTurns).toBe(1);
      server.release();
      expect(server.status().activeTurns).toBe(0);
      expect(server.status().restarts).toBe(0);
    } finally {
      await server.close();
    }
    expect(server.status().state).toBe("closed");
    // close 幂等
    await server.close();
  });

  it("env 指纹变化：无活跃轮次时自动重启，有活跃轮次时拒绝抢占", async () => {
    const server = createOpenCodeServer({
      command: process.execPath,
      leadingArgs: [scriptPath],
      healthIntervalMs: 20,
      readyTimeoutMs: 20_000,
    });
    try {
      const first = await server.ensureReady({ env: { FFPANE_RUN_API_KEY: "k1" } });
      const second = await server.ensureReady({ env: { FFPANE_RUN_API_KEY: "k2" } });
      expect(second).not.toBe(first);
      expect(server.status().restarts).toBe(1);

      server.acquire();
      await expect(
        server.ensureReady({ env: { FFPANE_RUN_API_KEY: "k3" } }),
      ).rejects.toBeInstanceOf(OpenCodeServerError);
      server.release();
    } finally {
      await server.close();
    }
  });

  it("子进程崩溃 → 状态转 crashed 并留下退出码与最近输出", async () => {
    const server = createOpenCodeServer({
      command: process.execPath,
      leadingArgs: [scriptPath],
      healthIntervalMs: 20,
      readyTimeoutMs: 20_000,
    });
    try {
      const client = await server.ensureReady();
      await fetch(`${client.baseUrl}/__crash`).catch(() => undefined);
      for (let i = 0; i < 200 && server.status().state !== "crashed"; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const status = server.status();
      expect(status.state).toBe("crashed");
      expect(status.lastExit?.exitCode).toBe(7);
      expect(status.recentOutput.some((line) => line.includes("listening on"))).toBe(true);

      // 崩溃后再要就绪 = 自动重启。
      const restarted = await server.ensureReady();
      expect(restarted.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(server.status().state).toBe("ready");
    } finally {
      await server.close();
    }
  });

  it("启动进行中 close：等 launch 落定再收，进程不从退出路径漏出（T8.5c 退出收敛）", async () => {
    const server = createOpenCodeServer({
      command: process.execPath,
      leadingArgs: [scriptPath],
      healthIntervalMs: 20,
      readyTimeoutMs: 20_000,
    });
    // 不 await：让 close 在 starting 阶段到达
    const starting = server.ensureReady();
    await server.close();
    expect(server.status().state).toBe("closed");
    // 进程真被收掉的观察点：lastExit 已落定（修复前 close 只清引用，
    // 进行中的 launch 稍后把 running 写回来，进程从退出路径漏出）
    expect(server.status().lastExit).toBeDefined();
    // 启动 promise 已落定（成功或被关停），不悬挂
    await starting.catch(() => undefined);
    // 关停后 ensureReady 拒绝（closed 是终态）
    await expect(server.ensureReady()).rejects.toBeInstanceOf(OpenCodeServerError);
  });

  it("公告缺席且未指定端口 → 就绪超时并给出可诊断的错误", async () => {
    const server = createOpenCodeServer({
      command: process.execPath,
      leadingArgs: [scriptPath],
      env: { FAKE_SERVE_SILENT: "1" },
      readyTimeoutMs: 800,
      healthIntervalMs: 20,
    });
    try {
      await expect(server.ensureReady()).rejects.toBeInstanceOf(OpenCodeServerError);
      expect(server.status().state).toBe("crashed");
    } finally {
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 适配器端到端。
 * ------------------------------------------------------------------ */

function stubServer(
  client: OpenCodeClient,
  counters: { acquired: number; released: number; restarts: number },
): OpenCodeServer {
  const status: OpenCodeServerStatus = {
    state: "ready",
    baseUrl: client.baseUrl,
    activeTurns: 0,
    restarts: 0,
    strippedEnvNames: [],
    recentOutput: [],
  };
  return {
    status: () => status,
    ensureReady: () => Promise.resolve(client),
    acquire: () => {
      counters.acquired += 1;
    },
    release: () => {
      counters.released += 1;
    },
    restart: () => {
      counters.restarts += 1;
      return Promise.resolve(client);
    },
    close: () => Promise.resolve(),
  };
}

describe("OpenCode 适配器（端到端，假 OpenCode Server）", () => {
  let fake: FakeOpenCode;

  afterEach(async () => {
    await fake?.close();
  });

  it("完整一轮：session_start → 流式文本 → 权限请求 → 批准 → file_change → end(completed)", async () => {
    fake = await startFakeOpenCode();
    const counters = { acquired: 0, released: 0, restarts: 0 };
    const client = createOpenCodeClient({ baseUrl: fake.baseUrl });
    const adapter = createOpenCodeAdapter({ server: stubServer(client, counters), agent: "build" });
    expect(adapter.runtime).toBe("opencode");
    expect(adapter.capabilities().permissionForwarding).toBe("yes");

    const cwd = "C:\\proj";
    const session = "ses_fake0001";
    const turn = adapter.startTurn({ cwd, prompt: "写个文件", model: "mockai/mock-model" });

    // 提示词到达后按真实录制的顺序推事件。
    void fake
      .waitFor((request) => request.url.includes("prompt_async"))
      .then(() => {
        fake.emit({
          type: "session.status",
          properties: { sessionID: session, status: { type: "busy" } },
        });
        fake.emit({
          type: "message.part.updated",
          properties: {
            sessionID: session,
            part: { id: "prt_t", messageID: "msg_a", type: "text", text: "", time: { start: 1 } },
          },
        });
        fake.emit({
          type: "message.part.delta",
          properties: {
            sessionID: session,
            messageID: "msg_a",
            partID: "prt_t",
            field: "text",
            delta: "写入中",
          },
        });
        fake.emit({
          type: "permission.asked",
          properties: {
            id: "per_x",
            sessionID: session,
            permission: "edit",
            patterns: ["proj\\hello.txt"],
            metadata: { filepath: "C:\\proj\\hello.txt", diff: "@@ -0,0 +1 @@\n+hi\n" },
            tool: { messageID: "msg_a", callID: "call_1" },
          },
        });
      });

    const events: AgentEvent[] = [];
    for await (const event of turn.events) {
      events.push(event);
      if (event.kind === "permission_request") {
        await turn.respondPermission?.(event.nativeRequestId, "allow");
        fake.emit({
          type: "message.part.updated",
          properties: {
            sessionID: session,
            part: {
              id: "prt_tool",
              messageID: "msg_a",
              type: "tool",
              tool: "write",
              callID: "call_1",
              state: {
                status: "completed",
                input: { filePath: "hello.txt" },
                output: "Wrote file successfully.",
                metadata: { filepath: "C:\\proj\\hello.txt", exists: false },
                time: { start: 1, end: 2 },
              },
            },
          },
        });
        fake.emit({
          type: "message.part.updated",
          properties: {
            sessionID: session,
            part: {
              id: "prt_sf",
              messageID: "msg_a",
              type: "step-finish",
              reason: "stop",
              tokens: {
                total: 30,
                input: 20,
                output: 10,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              cost: 0.25,
            },
          },
        });
        fake.emit({ type: "session.idle", properties: { sessionID: session } });
      }
    }

    expect(events.map((event) => event.kind)).toStrictEqual([
      "session_start",
      "text",
      "permission_request",
      "file_change",
      "raw",
      "end",
    ]);
    expect(events[0]).toStrictEqual({
      kind: "session_start",
      native: { nativeSessionId: session as NativeSessionId, cwd },
      model: "mockai/mock-model",
    });
    expect(events[3]).toMatchObject({
      kind: "file_change",
      path: "C:\\proj\\hello.txt",
      changeKind: "add",
      status: "completed",
      diff: "@@ -0,0 +1 @@\n+hi\n",
      actionId: "call_1",
    });
    expect(events.at(-1)).toStrictEqual({
      kind: "end",
      reason: "completed",
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, costUsd: 0.25 },
    });

    // 权限回执确实打到了 OpenCode 的回复端点。
    const replied = fake.requests.find((request) => request.url.includes("/permissions/"));
    expect(replied?.url).toBe(`/session/${session}/permissions/per_x`);
    expect(JSON.parse(replied?.body ?? "")).toStrictEqual({ response: "once" });
    // 引用计数有借有还。
    expect(counters).toStrictEqual({ acquired: 1, released: 1, restarts: 0 });
  });

  it("cancel：POST abort 后以 end(cancelled) 收尾，且幂等", async () => {
    fake = await startFakeOpenCode();
    const counters = { acquired: 0, released: 0, restarts: 0 };
    const client = createOpenCodeClient({ baseUrl: fake.baseUrl });
    const adapter = createOpenCodeAdapter({ server: stubServer(client, counters) });
    const session = "ses_fake0001";
    const turn = adapter.startTurn({ cwd: "C:\\proj", prompt: "慢慢来" });

    void fake
      .waitFor((request) => request.url.includes("prompt_async"))
      .then(() => {
        fake.emit({
          type: "session.status",
          properties: { sessionID: session, status: { type: "busy" } },
        });
        fake.emit({
          type: "message.part.delta",
          properties: {
            sessionID: session,
            messageID: "msg_a",
            partID: "prt_t",
            field: "text",
            delta: "思考",
          },
        });
      });
    void fake
      .waitFor((request) => request.url.includes("/abort"))
      .then(() => {
        fake.emit({ type: "session.idle", properties: { sessionID: session } });
      });

    const events: AgentEvent[] = [];
    for await (const event of turn.events) {
      events.push(event);
      if (event.kind === "text") {
        await turn.cancel();
      }
    }

    expect(events.map((event) => event.kind)).toStrictEqual(["session_start", "text", "end"]);
    expect(events.at(-1)).toMatchObject({ kind: "end", reason: "cancelled" });
    expect(fake.requests.some((request) => request.url.includes("/abort"))).toBe(true);
    await expect(turn.cancel()).resolves.toBeUndefined();
    expect(counters.released).toBe(1);
  });

  it("SSE 断流且无终止事件 → 合成 end(crashed)", async () => {
    fake = await startFakeOpenCode();
    const counters = { acquired: 0, released: 0, restarts: 0 };
    const client = createOpenCodeClient({ baseUrl: fake.baseUrl });
    const adapter = createOpenCodeAdapter({ server: stubServer(client, counters) });
    const turn = adapter.startTurn({ cwd: "C:\\proj", prompt: "然后服务挂了" });

    void fake
      .waitFor((request) => request.url.includes("prompt_async"))
      .then(async () => {
        fake.emit({
          type: "session.status",
          properties: { sessionID: "ses_fake0001", status: { type: "busy" } },
        });
        await fake.close();
      });

    const events: AgentEvent[] = [];
    for await (const event of turn.events) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({ kind: "end", reason: "crashed" });
  });

  it("resume 绑定的 cwd 与本轮不一致 → 快速失败为 end(failed)，不发请求", async () => {
    fake = await startFakeOpenCode();
    const counters = { acquired: 0, released: 0, restarts: 0 };
    const client = createOpenCodeClient({ baseUrl: fake.baseUrl });
    const adapter = createOpenCodeAdapter({ server: stubServer(client, counters) });
    const turn = adapter.startTurn({
      cwd: "C:\\proj",
      prompt: "继续",
      resume: { nativeSessionId: "ses_old" as NativeSessionId, cwd: "C:\\another" },
    });

    const events: AgentEvent[] = [];
    for await (const event of turn.events) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "end", reason: "failed" });
    expect(fake.requests).toHaveLength(0);
  });

  it("resume：会话目录与本轮 cwd 一致时正常恢复，sessionID 原样沿用", async () => {
    fake = await startFakeOpenCode({ sessionDirectory: "C:\\proj" });
    const counters = { acquired: 0, released: 0, restarts: 0 };
    const client = createOpenCodeClient({ baseUrl: fake.baseUrl });
    const adapter = createOpenCodeAdapter({ server: stubServer(client, counters) });
    const turn = adapter.startTurn({
      cwd: "C:\\proj",
      prompt: "继续",
      resume: { nativeSessionId: "ses_old" as NativeSessionId, cwd: "c:/proj" },
    });

    void fake
      .waitFor((request) => request.url.includes("prompt_async"))
      .then(() => {
        fake.emit({
          type: "session.status",
          properties: { sessionID: "ses_old", status: { type: "busy" } },
        });
        fake.emit({ type: "session.idle", properties: { sessionID: "ses_old" } });
      });

    const events: AgentEvent[] = [];
    for await (const event of turn.events) {
      events.push(event);
    }
    expect(events[0]).toMatchObject({
      kind: "session_start",
      native: { nativeSessionId: "ses_old", cwd: "C:\\proj" },
    });
    expect(events.at(-1)).toMatchObject({ kind: "end", reason: "completed" });
    // 恢复走 GET /session/:id 校验目录，没有新建会话。
    expect(fake.requests.some((request) => request.url.startsWith("/session?"))).toBe(false);
  });
});
