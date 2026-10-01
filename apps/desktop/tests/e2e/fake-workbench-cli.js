/**
 * T10.7a E2E 假 CLI：按 Claude 方式读取 --mcp-config，自行展开 ${VAR}，拉起 sidecar。
 * 按 whoami 是否有上级，走管理者或执行者脚本。不经 shell。
 */

const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

function expand(value) {
  return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, name) => {
    return process.env[name] ?? `\${${name}}`;
  });
}

function loadServer() {
  const argv = process.argv.slice(2);
  const index = argv.indexOf("--mcp-config");
  if (index < 0 || argv[index + 1] === undefined) {
    return undefined;
  }
  const raw = JSON.parse(readFileSync(argv[index + 1], "utf8"));
  const servers = raw.mcpServers ?? raw;
  return servers["ffpane-workbench"];
}

function startSidecar(spec) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    env[key] = expand(String(value));
  }
  return spawn(spec.command, spec.args ?? [], {
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function createSession(child) {
  let buffer = "";
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter !== undefined && line.trim().length > 0) {
        waiter(JSON.parse(line));
      }
      newline = buffer.indexOf("\n");
    }
  });
  let id = 0;
  return (method, params) => {
    id += 1;
    const pending = new Promise((resolve) => {
      waiters.push(resolve);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return pending;
  };
}

function toolText(response) {
  const result = response?.result ?? {};
  const content = Array.isArray(result.content) ? result.content[0] : undefined;
  return {
    text: typeof content?.text === "string" ? content.text : "",
    isError: result.isError === true,
  };
}

function fireStop(spec) {
  const script = Array.isArray(spec.args) ? spec.args[0] : undefined;
  if (typeof script !== "string") {
    return;
  }
  const hook = join(dirname(script), "workbench-hook.mjs");
  const child = spawn(process.execPath, [hook, "Stop"], {
    env: process.env,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
}

function keepAlive() {
  setInterval(() => undefined, 60_000);
}

async function main() {
  const spec = loadServer();
  if (spec === undefined || typeof spec.command !== "string") {
    process.stdout.write("FFPANE_MCP_NOCONFIG\n");
    keepAlive();
    return;
  }
  const sidecar = startSidecar(spec);
  let sidecarErr = "";
  sidecar.stderr.setEncoding("utf8");
  sidecar.stderr.on("data", (chunk) => {
    sidecarErr += chunk;
  });
  const request = createSession(sidecar);
  await request("initialize", { protocolVersion: "2025-06-18" });
  sidecar.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  const tool = async (name, args) =>
    toolText(await request("tools/call", { name, arguments: args }));

  let who = await tool("ffpane_whoami", {});
  for (let attempt = 0; attempt < 20 && who.isError; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    who = await tool("ffpane_whoami", {});
  }
  if (who.isError) {
    process.stdout.write(`FFPANE_MCP_ERROR=${who.text}\n`);
    process.stdout.write(`FFPANE_MCP_SIDECAR=${sidecarErr.slice(0, 400)}\n`);
    keepAlive();
    return;
  }
  const me = JSON.parse(who.text);
  if (me.parent !== null && me.parent !== undefined) {
    process.stdout.write("FFPANE_CHILD_MARKER=1\n");
    if (process.env.FFPANE_WB_SCRIPT === "close") {
      keepAlive();
      return;
    }
    if (process.env.FFPANE_WB_SCRIPT === "panel") {
      let briefPath;
      for (let attempt = 0; attempt < 30 && briefPath === undefined; attempt += 1) {
        const inbox = await tool("ffpane_read_inbox", { mode: "unread", limit: 20 });
        if (!inbox.isError) {
          try {
            const body = JSON.parse(inbox.text);
            for (const item of body.messages ?? []) {
              if (typeof item.briefPath === "string" && item.briefPath.length > 0) {
                briefPath = item.briefPath;
              }
            }
          } catch {
            briefPath = undefined;
          }
        }
        if (briefPath === undefined) {
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }
      const report = await tool("ffpane_report", {
        status: "blocked",
        summary: "缺接口",
        ...(briefPath !== undefined ? { briefPath } : {}),
      });
      process.stdout.write(`FFPANE_MCP_CHILD_REPORT=${report.isError ? "error" : "ok"}\n`);
      keepAlive();
      return;
    }
    const report = await tool("ffpane_report", { status: "done", summary: "前端完成" });
    const opened = await tool("ffpane_open_window", {
      cli: "claude",
      role: "worker",
      permission: "edit",
      title: "越权",
    });
    const sent = await tool("ffpane_send_message", {
      windowId: me.parent.windowId,
      text: "不该发给上级",
    });
    process.stdout.write(`FFPANE_MCP_WORKER_REPORT=${report.isError ? "error" : "ok"}\n`);
    process.stdout.write(`FFPANE_MCP_WORKER_OPEN=${opened.isError ? "denied" : "allowed"}\n`);
    process.stdout.write(`FFPANE_MCP_WORKER_SEND=${sent.isError ? "denied" : "allowed"}\n`);
    keepAlive();
    return;
  }

  if (process.env.FFPANE_WB_SCRIPT === "close") {
    const role = await tool("ffpane_set_role", { windowId: me.windowId, role: "manager" });
    if (role.isError) {
      process.stdout.write(`FFPANE_MCP_ERROR=${role.text}\n`);
      keepAlive();
      return;
    }
    const opened = await tool("ffpane_open_window", {
      cli: "claude",
      role: "worker",
      permission: "yolo",
      title: "前端关",
    });
    if (opened.isError) {
      process.stdout.write(`FFPANE_MCP_ERROR=${opened.text}\n`);
      keepAlive();
      return;
    }
    const child = JSON.parse(opened.text);
    let seen = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const output = await tool("ffpane_read_output", { windowId: child.windowId });
      if (!output.isError && output.text.includes("FFPANE_CHILD_MARKER=1")) {
        seen = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    process.stdout.write(`FFPANE_MCP_READ=${seen ? "yes" : "no"}\n`);
    const closed = await tool("ffpane_close_window", { windowId: child.windowId });
    process.stdout.write(`FFPANE_MCP_CLOSE=${closed.isError ? "error" : "ok"}\n`);
    const panel = await tool("ffpane_open_panel", { panel: "tasks" });
    process.stdout.write(`FFPANE_MCP_PANEL=${panel.isError ? "error" : "ok"}\n`);
    keepAlive();
    return;
  }

  if (process.env.FFPANE_WB_SCRIPT === "restart") {
    if (me.role === "manager") {
      let opened = await tool("ffpane_open_window", {
        cli: "claude",
        role: "worker",
        permission: "edit",
        title: "前端B",
      });
      for (let attempt = 0; attempt < 20 && opened.isError; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        opened = await tool("ffpane_open_window", {
          cli: "claude",
          role: "worker",
          permission: "edit",
          title: "前端B",
        });
      }
      process.stdout.write(`FFPANE_MCP_REOPEN=${opened.isError ? "error" : "ok"}\n`);
      keepAlive();
      return;
    }
    const role = await tool("ffpane_set_role", { windowId: me.windowId, role: "manager" });
    if (role.isError) {
      process.stdout.write(`FFPANE_MCP_ERROR=${role.text}\n`);
      keepAlive();
      return;
    }
    const opened = await tool("ffpane_open_window", {
      cli: "claude",
      role: "worker",
      permission: "yolo",
      title: "前端A",
    });
    if (opened.isError) {
      process.stdout.write(`FFPANE_MCP_ERROR=${opened.text}\n`);
      keepAlive();
      return;
    }
    const child = JSON.parse(opened.text);
    await tool("ffpane_send_message", { windowId: child.windowId, text: "开始吧" });
    process.stdout.write(`FFPANE_MCP_CHILD=${child.windowId}\n`);
    process.stdout.write("FFPANE_MCP_READY=1\n");
    keepAlive();
    return;
  }

  if (process.env.FFPANE_WB_SCRIPT === "panel") {
    const role = await tool("ffpane_set_role", { windowId: me.windowId, role: "manager" });
    if (role.isError) {
      process.stdout.write(`FFPANE_MCP_ERROR=${role.text}\n`);
      keepAlive();
      return;
    }
    const brief = await tool("ffpane_write_brief", {
      name: "board.md",
      content: "# 接口清单\n\n做前端",
    });
    if (brief.isError) {
      process.stdout.write(`FFPANE_MCP_ERROR=${brief.text}\n`);
      keepAlive();
      return;
    }
    const briefBody = JSON.parse(brief.text);
    const opened = await tool("ffpane_open_window", {
      cli: "claude",
      role: "worker",
      permission: "edit",
      title: "前端板",
      briefPath: briefBody.relativePath,
    });
    if (opened.isError) {
      process.stdout.write(`FFPANE_MCP_ERROR=${opened.text}\n`);
      keepAlive();
      return;
    }
    const child = JSON.parse(opened.text);
    await tool("ffpane_send_message", {
      windowId: child.windowId,
      text: "开始吧",
      briefPath: briefBody.relativePath,
    });
    let seen = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const inbox = await tool("ffpane_read_inbox", { mode: "unread", limit: 20 });
      if (!inbox.isError && inbox.text.includes("缺接口")) {
        seen = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    process.stdout.write(`FFPANE_MCP_CHILD_BLOCKED=${seen ? "yes" : "no"}\n`);
    const tasks = await tool("ffpane_open_panel", { panel: "tasks" });
    process.stdout.write(`FFPANE_MCP_PANEL_TASKS=${tasks.isError ? "error" : "ok"}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20000));
    const plan = await tool("ffpane_open_panel", { panel: "plan" });
    process.stdout.write(`FFPANE_MCP_PANEL_PLAN=${plan.isError ? "error" : "ok"}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20000));
    const runs = await tool("ffpane_open_panel", { panel: "runs" });
    process.stdout.write(`FFPANE_MCP_PANEL_RUNS=${runs.isError ? "error" : "ok"}\n`);
    keepAlive();
    return;
  }

  if (process.env.FFPANE_WB_SCRIPT === "panel-away") {
    const role = await tool("ffpane_set_role", { windowId: me.windowId, role: "manager" });
    if (role.isError) {
      process.stdout.write(`FFPANE_MCP_ERROR=${role.text}\n`);
      keepAlive();
      return;
    }
    process.stdout.write("FFPANE_MCP_HOLD=1\n");
    const trigger = process.env.FFPANE_WB_TRIGGER ?? "";
    let go = false;
    for (let attempt = 0; attempt < 80 && !go; attempt += 1) {
      try {
        go = readFileSync(trigger, "utf8").trim() === "go";
      } catch {
        go = false;
      }
      if (!go) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!go) {
      process.stdout.write("FFPANE_MCP_ERROR=trigger timeout\n");
      keepAlive();
      return;
    }
    const tasks = await tool("ffpane_open_panel", { panel: "tasks" });
    process.stdout.write(`FFPANE_MCP_PANEL_TASKS=${tasks.isError ? "error" : "ok"}\n`);
    keepAlive();
    return;
  }

  const role = await tool("ffpane_set_role", { windowId: me.windowId, role: "manager" });
  if (role.isError) {
    process.stdout.write(`FFPANE_MCP_ERROR=${role.text}\n`);
    keepAlive();
    return;
  }
  const brief = await tool("ffpane_write_brief", { name: "task.md", content: "做前端" });
  if (brief.isError) {
    process.stdout.write(`FFPANE_MCP_ERROR=${brief.text}\n`);
    keepAlive();
    return;
  }
  const briefBody = JSON.parse(brief.text);
  const opened = await tool("ffpane_open_window", {
    cli: "claude",
    role: "worker",
    permission: "edit",
    title: "前端A",
    briefPath: briefBody.relativePath,
    message: "请完成任务",
  });
  if (opened.isError) {
    process.stdout.write(`FFPANE_MCP_ERROR=${opened.text}\n`);
    keepAlive();
    return;
  }
  const child = JSON.parse(opened.text);
  await tool("ffpane_send_message", { windowId: child.windowId, text: "开始吧" });

  let stdin = "";
  process.stdin.on("data", (chunk) => {
    stdin += chunk.toString("utf8");
  });
  process.stdin.resume();
  for (let i = 0; i < 40 && !stdin.includes("[新消息]"); i += 1) {
    fireStop(spec);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!stdin.includes("[新消息]")) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  const inbox = await tool("ffpane_read_inbox", { mode: "unread", limit: 20 });
  process.stdout.write(`FFPANE_MCP_CHILD=${child.windowId}\n`);
  process.stdout.write(`FFPANE_MCP_REMINDER=${stdin.includes("[新消息]") ? "yes" : "no"}\n`);
  process.stdout.write(`FFPANE_MCP_INBOX=${inbox.text}\n`);
  process.stdout.write("FFPANE_MCP_DONE=1\n");
  keepAlive();
}

main().catch((error) => {
  process.stdout.write(
    `FFPANE_MCP_ERROR=${error instanceof Error ? error.message : String(error)}\n`,
  );
  keepAlive();
});
