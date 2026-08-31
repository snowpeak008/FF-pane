import { describe, expect, it } from "vitest";
import {
  CLI_LOGIN_RUNTIMES,
  type CliLoginRuntime,
  type CompletedExecution,
  DEFAULT_PROBE_TIMEOUT_MS,
  type ExecutionOutcome,
  isCliLoginRuntime,
  MAX_DETAIL_EXCERPT_LENGTH,
  type ProcessExecutor,
  probeCliLogin,
  sanitizeOutputExcerpt,
} from "../src/index.js";

/** 记录调用参数的假执行器。 */
function fakeExecutor(outcome: ExecutionOutcome): {
  execute: ProcessExecutor;
  calls: { cmd: string; args: readonly string[]; timeoutMs: number }[];
} {
  const calls: { cmd: string; args: readonly string[]; timeoutMs: number }[] = [];
  const execute: ProcessExecutor = (cmd, args, timeoutMs) => {
    calls.push({ cmd, args, timeoutMs });
    return Promise.resolve(outcome);
  };
  return { execute, calls };
}

function completed(exitCode: number, stdout = "", stderr = ""): CompletedExecution {
  return { kind: "completed", exitCode, stdout, stderr };
}

describe("probeCliLogin：codex（codex login status，退出码 0/1 判定）", () => {
  it("退出码 0 → logged_in（真机：文本走 stderr）", async () => {
    const { execute } = fakeExecutor(completed(0, "", "Logged in using ChatGPT\n"));
    const result = await probeCliLogin("codex", { execute });
    expect(result.status).toBe("logged_in");
    expect(result.probedWith).toBe("codex login status");
    expect(result.detail).toContain("退出码 0");
    expect(result.detail).toContain("Logged in using ChatGPT");
  });

  it("退出码 1 → logged_out", async () => {
    const { execute } = fakeExecutor(completed(1, "", "Not logged in\n"));
    const result = await probeCliLogin("codex", { execute });
    expect(result.status).toBe("logged_out");
  });

  it("非预期退出码 → unknown", async () => {
    const { execute } = fakeExecutor(completed(2, "", "panic: something broke"));
    const result = await probeCliLogin("codex", { execute });
    expect(result.status).toBe("unknown");
    expect(result.detail).toContain("非预期退出码");
  });
});

describe("probeCliLogin：claude-code（claude auth status，loggedIn 字段判定）", () => {
  const loggedInJson = `{
  "loggedIn": true,
  "authMethod": "oauth_token",
  "apiProvider": "firstParty"
}`;
  const loggedOutJson = `{
  "loggedIn": false,
  "authMethod": "none",
  "apiProvider": "firstParty"
}`;

  it("多行 JSON loggedIn:true → logged_in", async () => {
    const { execute } = fakeExecutor(completed(0, loggedInJson));
    const result = await probeCliLogin("claude-code", { execute });
    expect(result.status).toBe("logged_in");
    expect(result.probedWith).toBe("claude auth status");
  });

  it("loggedIn:false → logged_out（真机隔离配置目录实测退出码 1）", async () => {
    const { execute } = fakeExecutor(completed(1, loggedOutJson));
    const result = await probeCliLogin("claude-code", { execute });
    expect(result.status).toBe("logged_out");
  });

  it("JSON 前混入告警文本仍可判定", async () => {
    const { execute } = fakeExecutor(completed(0, `Warning: update available\n${loggedInJson}`));
    const result = await probeCliLogin("claude-code", { execute });
    expect(result.status).toBe("logged_in");
  });

  it("输出中无 loggedIn 字段 → unknown", async () => {
    const { execute } = fakeExecutor(completed(0, "Unexpected plain text output"));
    const result = await probeCliLogin("claude-code", { execute });
    expect(result.status).toBe("unknown");
    expect(result.detail).toContain("loggedIn");
  });
});

describe("probeCliLogin：gemini-cli（gemini --list-sessions，退出码 0/41 判定）", () => {
  it("退出码 0 → logged_in", async () => {
    const { execute } = fakeExecutor(completed(0, "No sessions found.\n"));
    const result = await probeCliLogin("gemini-cli", { execute });
    expect(result.status).toBe("logged_in");
    expect(result.probedWith).toBe("gemini --list-sessions");
  });

  it("退出码 41（FatalAuthenticationError，真机实测）→ logged_out", async () => {
    const { execute } = fakeExecutor(
      completed(
        41,
        "",
        "Please set an Auth method in your C:\\Users\\USER\\.gemini\\settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA\n",
      ),
    );
    const result = await probeCliLogin("gemini-cli", { execute });
    expect(result.status).toBe("logged_out");
    expect(result.detail).toContain("退出码 41");
  });

  it("HTTP 状态码直通的退出码（如 400）→ unknown", async () => {
    const { execute } = fakeExecutor(completed(400, "", "API Error: invalid key"));
    const result = await probeCliLogin("gemini-cli", { execute });
    expect(result.status).toBe("unknown");
  });

  it("目录未信任退出码 55 → unknown", async () => {
    const { execute } = fakeExecutor(completed(55));
    const result = await probeCliLogin("gemini-cli", { execute });
    expect(result.status).toBe("unknown");
  });
});

describe("probeCliLogin：opencode（opencode auth list，凭证计数判定）", () => {
  it("含 ANSI 色码的 0 credentials → logged_out（真机输出形态）", async () => {
    const stdout =
      "\u001B[0m\nT  Credentials \u001B[90m~\\.local\\share\\opencode\\auth.json\u001B[0m\n|\n—  0 credentials\n";
    const { execute } = fakeExecutor(completed(0, stdout));
    const result = await probeCliLogin("opencode", { execute });
    expect(result.status).toBe("logged_out");
    expect(result.probedWith).toBe("opencode auth list");
    expect(result.detail).toContain("已存凭证 0 个");
  });

  it("2 credentials → logged_in", async () => {
    const stdout =
      "T  Credentials ~\\.local\\share\\opencode\\auth.json\n|  anthropic oauth\n|  deepseek apikey\n—  2 credentials\n";
    const { execute } = fakeExecutor(completed(0, stdout));
    const result = await probeCliLogin("opencode", { execute });
    expect(result.status).toBe("logged_in");
    expect(result.detail).toContain("已存凭证 2 个");
  });

  it("单数形态 1 credential 也可判定", async () => {
    const { execute } = fakeExecutor(completed(0, "—  1 credential\n"));
    const result = await probeCliLogin("opencode", { execute });
    expect(result.status).toBe("logged_in");
  });

  it("无计数行 → unknown", async () => {
    const { execute } = fakeExecutor(completed(0, "unexpected output"));
    const result = await probeCliLogin("opencode", { execute });
    expect(result.status).toBe("unknown");
  });

  it("非零退出码 → unknown（即使输出中有计数行）", async () => {
    const { execute } = fakeExecutor(completed(1, "—  3 credentials\n"));
    const result = await probeCliLogin("opencode", { execute });
    expect(result.status).toBe("unknown");
  });
});

describe("probeCliLogin：grok-build（grok models，只看文本不看退出码）", () => {
  /** 真机实测（1.0.13，未登录）的 stdout 形态：首行是未登录标记，其后照常列模型。 */
  const NOT_AUTHENTICATED_STDOUT =
    "You are not authenticated.\n\nAvailable models:\n  grok-code-fast-1\n  grok-4-latest\n";

  it("退出码 0 + 首行未登录标记 → logged_out（退出码在本 Runtime 上不承载判据）", async () => {
    const { execute } = fakeExecutor(completed(0, NOT_AUTHENTICATED_STDOUT));
    const result = await probeCliLogin("grok-build", { execute });
    expect(result.status).toBe("logged_out");
    expect(result.probedWith).toBe("grok models");
    expect(result.detail).toContain("退出码 0");
  });

  it("另一措辞 not signed in 同样判 logged_out（不分大小写、含 ANSI、走 stderr）", async () => {
    const { execute } = fakeExecutor(
      completed(0, "", "\u001B[31mYou are NOT SIGNED IN\u001B[0m\n"),
    );
    const result = await probeCliLogin("grok-build", { execute });
    expect(result.status).toBe("logged_out");
  });

  it("退出码 0 且无未登录标记 → logged_in", async () => {
    const { execute } = fakeExecutor(completed(0, "Available models:\n  grok-4-latest\n"));
    const result = await probeCliLogin("grok-build", { execute });
    expect(result.status).toBe("logged_in");
  });

  it("非零退出码且无未登录标记 → unknown（不猜成未登录）", async () => {
    const { execute } = fakeExecutor(completed(1, "", "Error: network unreachable\n"));
    const result = await probeCliLogin("grok-build", { execute });
    expect(result.status).toBe("unknown");
    expect(result.detail).toContain("非零退出码且无未登录标记");
  });

  it("未登录标记优先于非零退出码 → logged_out", async () => {
    const { execute } = fakeExecutor(completed(1, NOT_AUTHENTICATED_STDOUT));
    const result = await probeCliLogin("grok-build", { execute });
    expect(result.status).toBe("logged_out");
  });
});

describe("probeCliLogin：五 runtime 通用三态", () => {
  const runtimes: readonly CliLoginRuntime[] = CLI_LOGIN_RUNTIMES;

  // 把「五」这个数字钉在断言上：日后 CLI_LOGIN_RUNTIMES 增删时这条先红，
  // 而不是留下一个像本条此前那样悄悄过期的测试标题。
  it("清单恰为五家，与本 describe 标题一致", () => {
    expect(CLI_LOGIN_RUNTIMES).toHaveLength(5);
  });

  it.each(runtimes)("%s：执行器报 cli_missing → cli_missing", async (runtime) => {
    const { execute } = fakeExecutor({ kind: "cli_missing" });
    const result = await probeCliLogin(runtime, { execute });
    expect(result.status).toBe("cli_missing");
    expect(result.detail).toContain("未找到可执行文件");
  });

  it.each(runtimes)("%s：执行器报 timeout → unknown", async (runtime) => {
    const { execute } = fakeExecutor({ kind: "timeout" });
    const result = await probeCliLogin(runtime, { execute });
    expect(result.status).toBe("unknown");
    expect(result.detail).toContain("超时");
  });

  it.each(runtimes)("%s：执行器抛异常 → unknown（不向上抛）", async (runtime) => {
    const execute: ProcessExecutor = () => Promise.reject(new Error("spawn blew up"));
    const result = await probeCliLogin(runtime, { execute });
    expect(result.status).toBe("unknown");
    expect(result.detail).toContain("执行器异常");
  });

  it("默认超时 10s 传给执行器，且可被 options.timeoutMs 覆盖", async () => {
    const first = fakeExecutor(completed(0));
    await probeCliLogin("codex", { execute: first.execute });
    expect(first.calls[0]?.timeoutMs).toBe(DEFAULT_PROBE_TIMEOUT_MS);
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(10_000);

    const second = fakeExecutor(completed(0));
    await probeCliLogin("codex", { execute: second.execute, timeoutMs: 30_000 });
    expect(second.calls[0]?.timeoutMs).toBe(30_000);
  });

  it("执行器收到的命令与参数即 probedWith 内容", async () => {
    const { execute, calls } = fakeExecutor(completed(0));
    const result = await probeCliLogin("gemini-cli", { execute });
    expect(calls[0]?.cmd).toBe("gemini");
    expect(calls[0]?.args).toEqual(["--list-sessions"]);
    expect(result.probedWith).toBe("gemini --list-sessions");
  });
});

describe("detail 敏感内容过滤与截断", () => {
  it("sk- 风格 key 不进入 detail", async () => {
    const secret = "sk-proj-abc123def456ghi789jkl";
    const { execute } = fakeExecutor(completed(0, `Logged in with key ${secret}`, ""));
    const result = await probeCliLogin("codex", { execute });
    expect(result.detail).not.toContain(secret);
    expect(result.detail).toContain("[REDACTED]");
  });

  it("JSON 凭证字段值被抹除、字段名保留", async () => {
    const stdout = `{
  "loggedIn": true,
  "accessToken": "ya29.SECRETSECRETSECRET",
  "apiKey": "topsecretvalue123"
}`;
    const { execute } = fakeExecutor(completed(0, stdout));
    const result = await probeCliLogin("claude-code", { execute });
    expect(result.status).toBe("logged_in");
    expect(result.detail).not.toContain("SECRETSECRET");
    expect(result.detail).not.toContain("topsecretvalue123");
    expect(result.detail).toContain("accessToken");
  });

  it("JWT 与 40+ 位长 token 被兜底抹除", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N";
    const blob = `${"A".repeat(24)}b1c2d3e4f5g6h7i8j9k0${"Z".repeat(10)}`;
    const sanitized = sanitizeOutputExcerpt(`token dump: ${jwt} and ${blob}`);
    expect(sanitized).not.toContain(jwt);
    expect(sanitized).not.toContain(blob);
    expect(sanitized).toContain("[REDACTED]");
  });

  it("超长输出被截断到上限并带标记", async () => {
    // 用带空格的长文本：连续同字符长串会命中长 token 兜底规则被整体抹除
    const { execute } = fakeExecutor(completed(2, "lorem ipsum ".repeat(500)));
    const result = await probeCliLogin("codex", { execute });
    expect(result.detail).toContain("…(已截断)");
    // detail = 前缀 + 摘录（≤上限 + 标记），总长受控
    expect(result.detail.length).toBeLessThan(MAX_DETAIL_EXCERPT_LENGTH + 100);
  });

  it("多行输出折叠为单行、ANSI 色码被剥离", () => {
    const sanitized = sanitizeOutputExcerpt("\u001B[90mline1\u001B[0m\r\nline2\n\nline3");
    expect(sanitized).toBe("line1 line2 line3");
  });
});

describe("isCliLoginRuntime 守卫", () => {
  it("接受五个合法值、拒绝其他", () => {
    for (const runtime of CLI_LOGIN_RUNTIMES) {
      expect(isCliLoginRuntime(runtime)).toBe(true);
    }
    expect(isCliLoginRuntime("grok")).toBe(false);
    expect(isCliLoginRuntime(42)).toBe(false);
    expect(isCliLoginRuntime(undefined)).toBe(false);
  });
});
