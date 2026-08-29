import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ADAPTER_CAPABILITY_NAMES,
  type AdapterCapabilities,
  type CapabilitySupport,
  type CommandEvent,
  createLineDecoder,
  decodeLines,
  type EndEvent,
  type FileChangeEvent,
  type InvalidJsonlLine,
  isAgentEventKind,
  isCapabilitySupport,
  type JsonlRecord,
  nativeEventType,
  type ParsedJsonlLine,
  type PermissionRequestEvent,
  parseJsonlLine,
  readJsonlStream,
  type StreamChunk,
  splitLines,
  type TextEvent,
  toRawEvent,
} from "../src/index.js";

const FIXTURES_ROOT = new URL("../fixtures/", import.meta.url);

/** fixtures/ 为只读的逐字节保真录制证据，测试一律按字节读入。 */
function readFixtureBytes(relativePath: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(relativePath, FIXTURES_ROOT)));
}

function sliceIntoChunks(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, offset + size));
  }
  return chunks;
}

async function* toAsyncIterable<T>(items: Iterable<T>): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) {
    items.push(item);
  }
  return items;
}

function readLines(chunks: Iterable<StreamChunk>): Promise<string[]> {
  return collect(decodeLines(toAsyncIterable(chunks)));
}

function readRecords(chunks: Iterable<StreamChunk>): Promise<JsonlRecord[]> {
  return collect(readJsonlStream(toAsyncIterable(chunks)));
}

function expectParsed(record: JsonlRecord | undefined): ParsedJsonlLine {
  if (record === undefined || !record.ok) {
    throw new Error(`期望解析成功，实得：${JSON.stringify(record)}`);
  }
  return record;
}

function expectInvalid(record: JsonlRecord | undefined): InvalidJsonlLine {
  if (record === undefined || record.ok) {
    throw new Error(`期望脏行，实得：${JSON.stringify(record)}`);
  }
  return record;
}

function eventTypesOf(records: readonly JsonlRecord[]): string[] {
  return records.map((record) => (record.ok ? nativeEventType(record.value) : "<invalid>") ?? "");
}

/** 四家各取一份真实事件流，用于切割一致性与能承载性冒烟。 */
const RUNTIME_FIXTURES = {
  codex: "codex/exec-basic.jsonl",
  claudeCode: "claude-code/01-basic-write-bash.jsonl",
  geminiCli: "gemini-cli/constructed-stream-json-success.jsonl",
  opencode: "opencode/server/sse-events.jsonl",
} as const;

describe("行解码器：任意切割粒度下的行完整性", () => {
  for (const [runtime, fixture] of Object.entries(RUNTIME_FIXTURES)) {
    it(`${runtime} —— 1 字节 / 7 字节 / 整块三种粒度切出相同的行`, async () => {
      const bytes = readFixtureBytes(fixture);
      const whole = await readLines([bytes]);
      expect(whole.length).toBeGreaterThan(0);
      expect(await readLines(sliceIntoChunks(bytes, 1))).toEqual(whole);
      expect(await readLines(sliceIntoChunks(bytes, 7))).toEqual(whole);
    });
  }

  it("多字节字符被切在 chunk 边界也不乱码（codex aggregated_output 实测含中文）", async () => {
    const bytes = readFixtureBytes(RUNTIME_FIXTURES.codex);
    const records = await readRecords(sliceIntoChunks(bytes, 1));
    const failedCommand = records
      .map((record) => expectParsed(record).raw)
      .find((raw) => raw.includes("方法调用失败"));
    expect(failedCommand).toBeDefined();
  });

  it("CRLF 与 LF 一致；末尾换行不产生空行；行内空行保留", async () => {
    expect(await readLines(['{"a":1}\r\n{"b":2}\r\n'])).toEqual(['{"a":1}', '{"b":2}']);
    expect(await readLines(['{"a":1}\n{"b":2}\n'])).toEqual(['{"a":1}', '{"b":2}']);
    expect(await readLines(["a\n\nb\n"])).toEqual(["a", "", "b"]);
  });

  it("字符串 chunk 与字节 chunk 结果一致", async () => {
    const bytes = readFixtureBytes(RUNTIME_FIXTURES.geminiCli);
    const text = new TextDecoder().decode(bytes);
    expect(await readLines([text])).toEqual(await readLines([bytes]));
  });

  it("splitLines 保持 T0.1 语义（包根导出不断）", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("no-newline")).toEqual(["no-newline"]);
    expect(splitLines('{"a":1}\r\n{"b":2}\r\n')).toEqual(['{"a":1}', '{"b":2}']);
    expect(splitLines("a\n\nb\n")).toEqual(["a", "", "b"]);
  });

  it("超长行按 maxLineLength 强制切出，不无界缓冲", () => {
    const decoder = createLineDecoder({ maxLineLength: 4 });
    expect(decoder.push("abcdefghij")).toEqual(["abcd", "efgh"]);
    expect(decoder.flush()).toEqual(["ij"]);
  });

  it("maxLineLength 非正整数即拒绝构造", () => {
    expect(() => createLineDecoder({ maxLineLength: 0 })).toThrow(RangeError);
  });
});

describe("JSONL 解析：非 JSON 行容错", () => {
  it("claude 跨 cwd resume 的非 JSON 首行不中断后续解析", async () => {
    const bytes = readFixtureBytes("claude-code/09-resume-wrong-cwd.jsonl");
    const records = await readRecords(sliceIntoChunks(bytes, 1));

    expect(records).toHaveLength(2);
    const dirty = expectInvalid(records[0]);
    expect(dirty.lineNumber).toBe(1);
    expect(dirty.raw).toContain("No conversation found with session ID");
    expect(dirty.reason).not.toBe("");
    expect(nativeEventType(expectParsed(records[1]).value)).toBe("result");
  });

  it("脏行夹在事件之间时行号连续、前后事件都不丢", async () => {
    const records = await readRecords([
      '{"type":"first"}\n',
      "! permission requested: edit; auto-rejecting\n",
      "\n",
      '{"type":"last"}\n',
    ]);

    expect(eventTypesOf(records)).toEqual(["first", "<invalid>", "last"]);
    expect(records.map((record) => record.lineNumber)).toEqual([1, 2, 4]);
  });

  it("硬杀截断的半行以脏行上交，不静默丢弃", async () => {
    const records = await readRecords(['{"type":"a"}\n{"type":"b"']);

    expect(records).toHaveLength(2);
    expect(expectInvalid(records[1]).raw).toBe('{"type":"b"');
  });

  it("顶层不是 JSON 对象的行按脏行处理（标量/数组不是事件）", () => {
    expect(expectInvalid(parseJsonlLine("123", 1)).reason).toBe("顶层不是 JSON 对象");
    expect(expectInvalid(parseJsonlLine("[1,2]", 1)).reason).toBe("顶层不是 JSON 对象");
  });

  it("空行不占用诊断通道", () => {
    expect(parseJsonlLine("", 1)).toBeUndefined();
    expect(parseJsonlLine("   ", 1)).toBeUndefined();
  });

  it("claude 硬杀截断流全行可解析且确实没有 result 事件", async () => {
    const records = await readRecords([
      readFixtureBytes("claude-code/07-hardkill-truncated.jsonl"),
    ]);

    expect(records.every((record) => record.ok)).toBe(true);
    expect(eventTypesOf(records)).not.toContain("result");
  });
});

describe("JSONL 解析：单行大 JSON", () => {
  it("真实最长行（claude 02 的 structuredPatch 行）逐字节切割后仍能解析", async () => {
    const bytes = readFixtureBytes("claude-code/02-resume-edit.jsonl");
    const byOne = await readRecords(sliceIntoChunks(bytes, 1));
    const whole = await readRecords([bytes]);

    expect(byOne).toEqual(whole);
    expect(Math.max(...whole.map((record) => record.raw.length))).toBeGreaterThan(3000);
  });

  it("15 KB 以上的单行 JSON 在 1 字节 / 13 字节切割下无损", async () => {
    const payload = {
      type: "item.completed",
      item: { type: "agent_message", text: "河".repeat(8000) },
    };
    const line = `${JSON.stringify(payload)}\n`;
    const bytes = new TextEncoder().encode(line);
    expect(bytes.length).toBeGreaterThan(15 * 1024);

    for (const size of [1, 13]) {
      const records = await readRecords(sliceIntoChunks(bytes, size));
      expect(records).toHaveLength(1);
      expect(expectParsed(records[0]).value).toEqual(payload);
    }
  });
});

describe("背压：拉模型下上游按需读取", () => {
  it("消费方不取下一条，上游 chunk 就不被读取", async () => {
    const chunks = ['{"type":"a"}\n{"type":"b"}\n', '{"type":"c"}\n'];
    let pulled = 0;
    async function* source(): AsyncGenerator<string> {
      for (const chunk of chunks) {
        pulled += 1;
        yield chunk;
      }
    }

    const iterator = readJsonlStream(source())[Symbol.asyncIterator]();
    expect(pulled).toBe(0);

    expect(nativeEventType(expectParsed((await iterator.next()).value).value)).toBe("a");
    expect(pulled).toBe(1);
    expect(nativeEventType(expectParsed((await iterator.next()).value).value)).toBe("b");
    expect(pulled).toBe(1);
    expect(nativeEventType(expectParsed((await iterator.next()).value).value)).toBe("c");
    expect(pulled).toBe(2);
  });

  it("消费方提前退出时上游被关闭（不再继续读）", async () => {
    let pulled = 0;
    let closed = false;
    async function* source(): AsyncGenerator<string> {
      try {
        for (const chunk of ['{"type":"a"}\n', '{"type":"b"}\n']) {
          pulled += 1;
          yield chunk;
        }
      } finally {
        closed = true;
      }
    }

    for await (const record of readJsonlStream(source())) {
      expect(nativeEventType(expectParsed(record).value)).toBe("a");
      break;
    }

    expect(pulled).toBe(1);
    expect(closed).toBe(true);
  });
});

describe("四家真实 fixture 的能承载性冒烟", () => {
  it("codex：全行可解析，首尾事件为 thread.started / turn.completed", async () => {
    const records = await readRecords([readFixtureBytes(RUNTIME_FIXTURES.codex)]);
    const types = eventTypesOf(records);

    expect(records.every((record) => record.ok)).toBe(true);
    expect(types.at(0)).toBe("thread.started");
    expect(types.at(-1)).toBe("turn.completed");
    expect(types).toContain("item.completed");
  });

  it("claude-code：全行可解析，首尾事件为 system/init 与 result", async () => {
    const records = await readRecords([readFixtureBytes(RUNTIME_FIXTURES.claudeCode)]);
    const types = eventTypesOf(records);

    expect(records.every((record) => record.ok)).toBe(true);
    expect(types.at(0)).toBe("system");
    expect(expectParsed(records[0]).value["subtype"]).toBe("init");
    expect(types.at(-1)).toBe("result");
    expect(types).toContain("assistant");
    expect(types).toContain("user");
  });

  it("gemini-cli：六类事件的 type 字段可访问", async () => {
    const records = await readRecords([readFixtureBytes(RUNTIME_FIXTURES.geminiCli)]);
    const types = new Set(eventTypesOf(records));

    expect(records.every((record) => record.ok)).toBe(true);
    expect([...types].sort()).toEqual(["init", "message", "result", "tool_result", "tool_use"]);
  });

  it("opencode：156 条 SSE 事件全行可解析，含逐 token 增量与权限请求", async () => {
    const records = await readRecords([readFixtureBytes(RUNTIME_FIXTURES.opencode)]);
    const types = eventTypesOf(records);

    expect(records).toHaveLength(156);
    expect(records.every((record) => record.ok)).toBe(true);
    expect(types.at(0)).toBe("server.connected");
    expect(types.filter((type) => type === "message.part.delta")).toHaveLength(28);
    expect(types).toContain("permission.asked");
  });
});

/**
 * 事件类型骨架的承载性断言：证明四家的差异点都有落点，映射器（W2.3~2.6）
 * 不会被类型挡住。此处不做映射逻辑，只从真实事件里取出关键字段装进统一事件。
 */
describe("统一事件类型对四家差异的承载性", () => {
  interface CodexFileChangeItem {
    readonly item?: {
      readonly id?: string;
      readonly type?: string;
      readonly status?: string;
      readonly changes?: readonly { readonly path?: string; readonly kind?: string }[];
    };
  }

  it("codex 的 file_change 无 diff —— diff 字段缺席而非空串", async () => {
    const records = await readRecords([readFixtureBytes(RUNTIME_FIXTURES.codex)]);
    const source = records
      .map((record) => expectParsed(record).value as unknown as CodexFileChangeItem)
      .find((value) => value.item?.type === "file_change" && value.item?.status === "completed");
    const change = source?.item?.changes?.[0];
    expect(change?.kind).toBe("add");

    const event: FileChangeEvent = {
      kind: "file_change",
      path: change?.path ?? "",
      changeKind: "add",
      status: "completed",
      ...(source?.item?.id === undefined ? {} : { actionId: source.item.id }),
    };

    expect("diff" in event).toBe(false);
    expect(event.actionId).toBe("item_1");
  });

  interface GeminiToolResult {
    readonly tool_id?: string;
    readonly status?: string;
    readonly output?: string;
  }

  it("gemini 的命令无结构化退出码 —— exitCode 缺席，成败由 status 承载", async () => {
    const records = await readRecords([readFixtureBytes(RUNTIME_FIXTURES.geminiCli)]);
    const result = records
      .map((record) => expectParsed(record).value)
      .filter((value) => nativeEventType(value) === "tool_result")
      .map((value) => value as unknown as GeminiToolResult)
      .find((value) => value.tool_id?.startsWith("run_shell_command") === true);
    expect(result?.status).toBe("success");

    const event: CommandEvent = {
      kind: "command",
      command: "node -v",
      status: "completed",
      ...(result?.output === undefined ? {} : { output: result.output }),
      ...(result?.tool_id === undefined ? {} : { actionId: result.tool_id }),
    };

    expect("exitCode" in event).toBe(false);
    expect(event.status).toBe("completed");
    expect(event.output).toBe("v24.4.0");
  });

  interface OpencodePermissionAsked {
    readonly properties?: {
      readonly id?: string;
      readonly permission?: string;
      readonly metadata?: { readonly filepath?: string; readonly diff?: string };
    };
  }

  it("opencode 的 permission.asked 带原生请求 ID 与 unified diff", async () => {
    const records = await readRecords([readFixtureBytes(RUNTIME_FIXTURES.opencode)]);
    const asked = records
      .map((record) => expectParsed(record).value)
      .filter((value) => nativeEventType(value) === "permission.asked")
      .map((value) => value as unknown as OpencodePermissionAsked)
      .at(0);
    const properties = asked?.properties;
    expect(properties?.permission).toBe("edit");

    const event: PermissionRequestEvent = {
      kind: "permission_request",
      nativeRequestId: properties?.id ?? "",
      payload: { kind: "write_path", path: properties?.metadata?.filepath ?? "" },
      ...(properties?.metadata?.diff === undefined ? {} : { diff: properties.metadata.diff }),
      ...(properties?.permission === undefined ? {} : { toolName: properties.permission }),
    };

    expect(event.nativeRequestId).toMatch(/^per_/);
    expect(event.payload.kind).toBe("write_path");
    expect(event.diff).toContain("@@");
  });

  interface ClaudeResult {
    readonly subtype?: string;
    readonly total_cost_usd?: number;
    readonly usage?: {
      readonly input_tokens?: number;
      readonly output_tokens?: number;
      readonly cache_read_input_tokens?: number;
    };
  }

  it("claude 的 result 承载 end + usage", async () => {
    const records = await readRecords([readFixtureBytes(RUNTIME_FIXTURES.claudeCode)]);
    const result = records
      .map((record) => expectParsed(record).value)
      .filter((value) => nativeEventType(value) === "result")
      .map((value) => value as unknown as ClaudeResult)
      .at(0);
    expect(result?.subtype).toBe("success");

    const usage = result?.usage;
    const event: EndEvent = {
      kind: "end",
      reason: "completed",
      usage: {
        ...(usage?.input_tokens === undefined ? {} : { inputTokens: usage.input_tokens }),
        ...(usage?.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens }),
        ...(usage?.cache_read_input_tokens === undefined
          ? {}
          : { cachedInputTokens: usage.cache_read_input_tokens }),
        ...(result?.total_cost_usd === undefined ? {} : { costUsd: result.total_cost_usd }),
      },
      exitCode: 0,
    };

    expect(event.reason).toBe("completed");
    expect(event.usage?.outputTokens).toBeGreaterThan(0);
    expect(event.usage?.costUsd).toBeGreaterThan(0);
  });

  interface ClaudeStreamEvent {
    readonly event?: { readonly type?: string; readonly delta?: { readonly text?: string } };
  }

  it("token 级增量与整条消息统一为追加语义 + final 标记", async () => {
    const deltas = (await readRecords([readFixtureBytes("claude-code/06-partial-messages.jsonl")]))
      .map((record) => expectParsed(record).value)
      .filter((value) => nativeEventType(value) === "stream_event")
      .map((value) => value as unknown as ClaudeStreamEvent)
      .filter((value) => value.event?.type === "content_block_delta")
      .map(
        (value): TextEvent => ({
          kind: "text",
          content: value.event?.delta?.text ?? "",
          final: false,
          channel: "answer",
        }),
      );
    expect(deltas.length).toBeGreaterThan(1);

    // 定稿事件允许 content 为空 —— 只作收尾信号，不与增量重复。
    const stream: TextEvent[] = [
      ...deltas,
      { kind: "text", content: "", final: true, channel: "answer" },
    ];
    const appended = stream.map((event) => event.content).join("");
    expect(appended).toContain("Streaming test OK");
    expect(stream.filter((event) => event.final)).toHaveLength(1);

    // codex 的整条到达：单条事件即追加 + 收尾。
    const codexText: TextEvent = {
      kind: "text",
      content: "整条到达",
      final: true,
      channel: "answer",
    };
    expect(codexText.final).toBe(true);
  });
});

describe("raw 兜底事件", () => {
  it("原生事件原样透传并自动标注来源与 type", async () => {
    const record = expectParsed(
      (await readRecords([readFixtureBytes(RUNTIME_FIXTURES.opencode)])).at(0),
    );
    const event = toRawEvent("opencode", record.value);

    expect(event.kind).toBe("raw");
    expect(event.runtime).toBe("opencode");
    expect(event.nativeType).toBe("server.connected");
    expect(event.native).toBe(record.value);
    expect("note" in event).toBe(false);
  });

  it("脏行经 raw 通道上交原文与失败原因", () => {
    const dirty = expectInvalid(parseJsonlLine("No conversation found with session ID: x", 1));
    const event = toRawEvent("claude-code", dirty.raw, dirty.reason);

    expect(event.native).toBe(dirty.raw);
    expect(event.note).toBe(dirty.reason);
    expect("nativeType" in event).toBe(false);
  });

  it("raw 是第七种事件判别值", () => {
    expect(isAgentEventKind("raw")).toBe(true);
    expect(isAgentEventKind("session_start")).toBe(true);
    expect(isAgentEventKind("tool_use")).toBe(false);
  });
});

describe("AdapterCapabilities：设计文档 §5.1 六项能力三态声明", () => {
  it("能力名清单与类型键集合一致（六项，顺序同 §5.1）", () => {
    // 以 codex 的调研结论（docs/adapters/codex.md §6）作样本，验证三态可如实表达。
    const codexCapabilities: AdapterCapabilities = {
      nativeResume: "yes",
      streaming: "partial",
      fileChangeEvents: "partial",
      commandEvents: "yes",
      permissionForwarding: "no",
      gracefulCancel: "partial",
    };

    expect(Object.keys(codexCapabilities)).toEqual([...ADAPTER_CAPABILITY_NAMES]);
    expect(ADAPTER_CAPABILITY_NAMES).toHaveLength(6);
  });

  it("三态取值守卫拒绝布尔遗留值", () => {
    const values: CapabilitySupport[] = ["yes", "partial", "no"];
    for (const value of values) {
      expect(isCapabilitySupport(value)).toBe(true);
    }
    expect(isCapabilitySupport("true")).toBe(false);
    expect(isCapabilitySupport("unknown")).toBe(false);
  });
});
