# Grok Build ACP fixtures 补录（T8.5b，真机录制，模型端为本地假服务）

- **CLI 版本：** grok 1.0.13（`5e9a58528b76`），与既有 headless fixtures 同版本
- **录制日期：** 2026-09-05
- **录制环境：** Windows 10，Node v24.15.0
- **通道：** `grok agent -m <model> --no-leader stdio`（ACP over stdio，JSON-RPC/NDJSON）
- **调研文档：** `docs/adapters/grok-build.md` §7.4（本次转为实测）
- **性质口径：** 与本目录 `README.md` 一致——**CLI 行为全真**（事件帧、工具落地、
  权限往返、取消语义全部出自 grok 本体），模型回话来自
  `fixtures/tools/fake-openai-server.mjs` 的可复现脚本，经临时 GROK_HOME 的自定义
  模型配置接入（用户的 `~/.grok` 分毫不动）。

## 录制内容

`grok agent stdio` 的 **stdout 原样逐行留档**：JSON-RPC 响应、`session/update` 通知、
`session/request_permission` 请求、`_x.ai/*` 私有通知全部保留，未做删行。录制驱动为
一个最小 ACP Client（initialize → session/new → session/prompt，权限请求按场景回执，
Client 出站帧不在文件内——文件是「Agent 说了什么」的证据）。

| 文件 | 内容 | 权限回执 |
|---|---|---|
| `real-acp-success.jsonl` | 完整成功轮：initialize 响应（protocolVersion 1 / loadSession true / authMethods 含 `xai.api_key` 与 `grok.com`）→ session/new 响应（**sessionId 开轮即得**——headless 的「§7.3 坑 5」在本模式不存在）→ 写文件（tool_call → 带 diff 的 update → **session/request_permission**（id=0，选项 allow_always/allow_once/reject_once）→ completed，`_meta.details` 在）→ 跑命令（request_permission（id=1，选项面多一枚 reject_always）→ in_progress ×2 → completed，rawOutput 含 exit_code / output_file）→ agent_message_chunk 真增量 ×2 → prompt 响应 stopReason=end_turn（usage 在 `_meta`，**camelCase**，与 headless end 的 snake_case 不同源） | 全部 allow_once |
| `real-acp-deny.jsonl` | 写文件的权限请求被拒：tool_call_update `status:"failed"` +「**User rejected the execution** for tool `write`」——与 headless 无审批路径的「User cancelled the execution」**措辞不同**，是 `mapper.ts` DENIAL_MARKERS 第四条的实录出处 → prompt 响应 **stopReason=cancelled**（`_x.ai/session/prompt_complete` 带 `cancellationCategory:"PermissionRejected"`） | write 选 reject_once |
| `real-acp-cancel.jsonl` | 优雅取消：命令完成后模型端被拖住（脚本 delayMs），Client 发 `session/cancel` 通知 → grok 自己收工，prompt 响应 **stopReason=cancelled**（`cancellationCategory:"MidTurnAbort"`），**无需树杀** | 命令 allow_once |

## 三条关键实证（转入 grok-build.md §7.4）

1. **ACP wire 的 `tool_call` 顶层不带 `kind`/`toolName`**：权威值在
   `_meta["x.ai/tool"]` 的 `kind`/`name`（headless 的 streaming-json 投影把它们提升到
   顶层）。适配器的逆投影（`acp-turn.ts` acpUpdateToNativeRecord）据此补齐。
2. **权限选项的 `allow_always`/`reject_always` 改变 grok 的会话内后续询问行为**
   （「don't ask again」字样）。适配器恒选 `*_once`——FF-pane 的裁决是逐次的，
   选 always 等于把一次放行升格成会话级豁免。
3. **ACP 与 headless 的会话互通**（1.0.13 三向实测，未录成文件、结论落 §7.4）：
   ACP session/new 建的 sessionId → headless `-r` 恢复成功（上下文在）→ ACP
   session/load 再加载成功，同一 UUID 全程有效。两模式读写同一份
   `$GROK_HOME/sessions/` 存储。

## 脱敏说明

与 `README.md` 同一口径：`C:/Users/admin` → `C:/Users/USER`（含 URL 编码形态
`C%3A%5CUsers%5Cadmin` → `%5CUSER%5C`）、`"hostname":"snowpeak"` → `"hostname":"HOST"`；
sessionId / requestId / agentId 等随机 UUID 不含账号信息，保留原值。除上述替换外
未做任何增删改，每行均为 CLI 原样输出的合法 JSON。

## 复现录制

```bash
# 1) 起假模型服务端（同 README.md）
node packages/adapters/fixtures/tools/fake-openai-server.mjs --port 8195 --script <脚本.json>

# 2) 以临时 GROK_HOME spawn ACP 通道并驱动一轮（等价的最小 Client 逻辑见
#    scripts/live-grok-acp.mjs——它走真实适配器，判据更全）
GROK_HOME=<临时目录> GROK_DISABLE_AUTOUPDATER=1 \
  grok agent -m ffpane-live --no-leader stdio
# stdin 逐行写 initialize / session/new / session/prompt 请求，stdout 逐行留档
```

## 未覆盖（与 headless 口径一致）

真实 xAI 后端特有字段（登录后可补录）：`agent_thought_chunk`（假模型不产思考块）、
`plan` 更新、`stopReason` 的 `refusal`/`max_tokens` 取值、authenticate 对 `grok.com`
OAuth 方式的实际流程。
