/**
 * 工作台 MCP 工具声明（T10.7a / T10.7b / T10.10）。
 * 描述与参数与 Phase 10 §3.2.1 及角色说明书一致。
 * sidecar 只列出并转发这些工具，不做授权判断。
 */

import { WORKBENCH_ROLES } from "@ff-pane/shared";
import type { McpToolDefinition } from "./protocol";

export const WORKBENCH_MCP_SERVER_NAME = "ffpane-workbench";

export const WORKBENCH_MCP_TOOL_NAMES = [
  "ffpane_whoami",
  "ffpane_list_windows",
  "ffpane_set_role",
  "ffpane_write_brief",
  "ffpane_write_status",
  "ffpane_open_window",
  "ffpane_send_message",
  "ffpane_report",
  "ffpane_read_inbox",
  "ffpane_read_output",
  "ffpane_close_window",
  "ffpane_open_panel",
  "ffpane_open_canvas",
  "ffpane_generate_image",
  "ffpane_delete_canvas_file",
  "ffpane_export_canvas_image",
  "ffpane_memory_search",
  "ffpane_memory_add",
  "ffpane_set_model_effort",
  "ffpane_set_permission",
  "ffpane_broadcast",
  "ffpane_lock",
  "ffpane_nudge",
  "ffpane_request_decision",
  "ffpane_wait_events",
  "ffpane_restart_window",
] as const;

export type WorkbenchMcpToolName = (typeof WORKBENCH_MCP_TOOL_NAMES)[number];

const ROLE_ENUM = WORKBENCH_ROLES;
const PERMISSION_ENUM = ["read-only", "edit", "edit-exec", "yolo"] as const;
const REPORT_STATUS_ENUM = ["done", "blocked", "failed", "progress"] as const;
const PANEL_ENUM = ["plan", "tasks", "runs"] as const;
const MEMORY_CATEGORY_ENUM = ["decision", "rule", "lesson"] as const;

/**
 * 只读档也要能用的协作工具：只读写 .ffpane/ 里的协作文件（briefs、threads）或只读状态，
 * 不改项目代码，也不指挥别的窗口。Claude 只读档是 plan 模式，只放行 readOnlyHint 的工具
 * （实测 2.1.302：没有这个注解时 --allowedTools 也放不开）。
 * 开窗、发消息、关窗、改权限、生图这类会影响别的窗口或项目文件的工具不加。
 */
export const WORKBENCH_READ_ONLY_TOOL_NAMES: readonly WorkbenchMcpToolName[] = [
  "ffpane_whoami",
  "ffpane_list_windows",
  "ffpane_write_brief",
  "ffpane_write_status",
  "ffpane_report",
  "ffpane_read_inbox",
  "ffpane_read_output",
  "ffpane_open_panel",
  "ffpane_open_canvas",
  "ffpane_memory_search",
  "ffpane_lock",
  "ffpane_nudge",
  "ffpane_wait_events",
];

const TOOL_DEFINITIONS: readonly McpToolDefinition[] = [
  {
    name: "ffpane_restart_window",
    description:
      "重启你自己开的只读窗口（比如改模型没能生效、窗口卡住）。只有管理者能用，只能重启你开的、权限是只读的窗口；在等用户批准时不重启。能续接就续接原对话并带上窗口上记的模型和思考强度；续接不了，或 fresh 为 true，就开一段新对话（原对话不续）。返回实际的模型和思考强度。",
    inputSchema: {
      type: "object",
      properties: {
        windowId: { type: "string", description: "要重启的窗口 id。" },
        fresh: {
          type: "boolean",
          description: "true = 不续接，开新对话。缺省 false：能续接就续接。",
        },
      },
      required: ["windowId"],
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_wait_events",
    description:
      "在线监管：挂着等跟你有关的事件，有事件立刻返回，没有就到点返回。事件包括平台状态提醒（限流、卡住、空闲没汇报、等批准、退出）、锁轮到你、投递失败，以及新消息（正文附在 messages 里，已标记已读）。处理完就再调用一次接着等，这样你会一直在线，回合不结束。返回 stop 为 true 表示用户叫停了，处理完手头的事就结束本轮，不要再调用。",
    inputSchema: {
      type: "object",
      properties: {
        timeoutSec: {
          type: "number",
          description: "最多等多少秒，缺省 240，范围 10 到 540。",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_nudge",
    description:
      "叫醒被打断或卡住的窗口，让它从停下的地方接着做。网络或服务端的临时故障平台会自己让它接着做，不用叫；因限流这一类暂停的窗口在等用户的指令，监管者不能叫醒。只能叫醒自己的后代，或挂在你名下的窗口（监管者用）。只打一句平台固定的「继续」，不带你的任何文字，所以不能用来下命令。对方正忙就排队，空闲后送达；状态未知（比如刚重启）也会直接按回车。当场打进去的会核对有没有真的提交，没提交补一次回车，还不行就返回 not-submitted。",
    inputSchema: {
      type: "object",
      properties: {
        windowId: { type: "string", description: "要叫醒的窗口 id。" },
      },
      required: ["windowId"],
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_request_decision",
    description:
      "请用户拍板，相当于把计划交给用户审：先用 ffpane_write_brief 把要处理的事写成计划（背景、要决定什么、每个选项意味着什么、你的建议），再调用本工具，question 写这一件要决定的事，options 给 2 到 4 个选项，briefPath 填计划路径。界面会直接显示计划和选项，用户点选或写下决定，结果作为一条消息发回给你。只有管理者，或用户自己开的顶层窗口能用。可以自己查清的事不要问。",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "要拍板的事，一句话，最多 500 字。" },
        options: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 4,
          description: "2 到 4 个互不相同的选项，每个最多 120 字。写清每个选项意味着什么。",
        },
        briefPath: {
          type: "string",
          description: "必填。计划在 .ffpane/briefs/ 里的路径，界面会直接显示。",
        },
      },
      required: ["question", "options", "briefPath"],
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_whoami",
    description:
      "返回本窗口的 id、标题、角色、权限、上级（id 与标题）、项目名与项目根目录。任何窗口都可调用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ffpane_list_windows",
    description:
      "列出本窗口可见的窗口：自己、自己的后代、以及上级链。不含兄弟和无关窗口。每项含角色、权限、是否在运行、最近一次汇报状态，以及现在用的模型和思考强度（modelSource 说明是读自屏幕、启动参数还是 CLI 用户配置；pendingModelEffort 是已记下还没生效的设置）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ffpane_set_role",
    description:
      "设定某个窗口的角色（manager 管理者 / planner 规划 / worker 执行 / reviewer 检查 / supervisor 监管者 / none 普通）。把自己设为管理者仅限用户开启的顶层窗口；也可以设定自己后代的角色。其余情况会被拒绝。",
    inputSchema: {
      type: "object",
      properties: {
        windowId: { type: "string", description: "目标窗口 id。把自己设为管理者时填自己的 id。" },
        role: { type: "string", enum: [...ROLE_ENUM], description: "新角色。" },
      },
      required: ["windowId", "role"],
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_write_brief",
    description:
      "在本窗口所属项目的 .ffpane/briefs/ 下写一份任务说明 Markdown，返回项目内相对路径和绝对路径。任何角色、任何权限（含只读）都可以调用，因为写入被限定在 briefs 目录。不要传绝对路径或 .. 。mode 缺省 new：重名自动加序号。同一件事反复更新时用 overwrite 覆盖同名文件，或 append 追加到末尾，免得出现 -2、-3 多个版本。正文上限 256KB；更长的内容请拆分。",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "文件名，例如 plan.md。只能是 briefs 目录内的文件名。",
        },
        content: { type: "string", description: "Markdown 正文。" },
        mode: {
          type: "string",
          enum: ["new", "overwrite", "append"],
          description: "new 重名加序号（缺省）；overwrite 覆盖同名；append 追加到同名末尾。",
        },
      },
      required: ["name", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_write_status",
    description:
      "覆盖写入本窗口所属项目 .ffpane/briefs/ 下的一份近况。同名直接盖掉，不追加，也不另起序号。任何角色、任何权限都可以调用。不要传绝对路径或 .. 。正文上限 256KB。",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "文件名，例如 status.md。只能是 briefs 目录内的文件名。",
        },
        content: { type: "string", description: "近况正文。监管者只写四行，每次覆盖。" },
      },
      required: ["name", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_open_window",
    description:
      "开一个子窗口并派活。仅管理者可调用，且该管理者身份必须是本进程里通过 ffpane_set_role 或界面确认过的（仅从布局里读到的管理者不够）。权限不得超过你自己的有效权限，超出会被封顶并在结果里说明。子窗口工作目录是项目根。briefPath 必须位于该项目 .ffpane/briefs/ 内。",
    inputSchema: {
      type: "object",
      properties: {
        cli: {
          type: "string",
          enum: ["claude", "codex", "grok", "deepseek"],
          description: "子窗口使用的 CLI。deepseek 启动本机 Claude，模型是 DeepSeek。",
        },
        profileId: {
          type: "string",
          description: "已忽略。子窗口按调用者所在项目的配置选路；这一路没配会失败。",
        },
        role: { type: "string", enum: [...ROLE_ENUM], description: "子窗口角色。" },
        permission: {
          type: "string",
          enum: [...PERMISSION_ENUM],
          description: "子窗口权限，不得超过调用者。",
        },
        title: { type: "string", description: "子窗口标题。" },
        briefPath: {
          type: "string",
          description: "任务说明的项目内相对路径或绝对路径，必须在 .ffpane/briefs/ 内。",
        },
        message: { type: "string", description: "附加给子窗口的第一句话。整段初始指令上限 32KB。" },
        supervisorWindowId: {
          type: "string",
          description:
            "可选。挂上观察这个窗口的监管者（你开的、角色为监管者）。监管者能读它的终端、收它汇报的抄送，不能下命令。挂了以后，它 done 和 progress 的汇报不叫醒你，blocked 和 failed 照常叫醒。",
        },
        model: {
          type: "string",
          description:
            "可选。子窗口的模型，用启动参数传给 CLI（Claude 的 --model、Codex 的 -m），也记在窗口上，以后重启照用。不填就是 CLI 读用户自己的配置。",
        },
        reasoningEffort: {
          type: "string",
          description:
            "可选。子窗口的思考强度：none、minimal、low、medium、high、xhigh、max。用启动参数传（Claude 的 --effort、Codex 的 -c model_reasoning_effort），不改用户的全局配置。",
        },
      },
      required: ["cli", "role", "permission", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_send_message",
    description:
      "给自己的后代窗口发消息或指令。不能发给自己、上级或兄弟。正文上限 8KB，更长请改用 ffpane_write_brief，消息里只放路径。",
    inputSchema: {
      type: "object",
      properties: {
        windowId: { type: "string", description: "后代窗口 id。" },
        text: { type: "string", description: "消息正文。" },
        briefPath: { type: "string", description: "可选，项目 .ffpane/briefs/ 内的说明路径。" },
        detailPath: {
          type: "string",
          description:
            "可选。监管者交给管理者时，详细记录的路径，必须在 .ffpane/briefs/ 内。不要把正文放进来。",
        },
      },
      required: ["windowId"],
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_report",
    description:
      "向上级链汇报。windowId 缺省时汇报给直接上级。status 只能是 done、blocked、failed、progress。summary 上限 8KB，更长请改用 ffpane_write_brief。files 是项目内相对路径，不能越出项目根。监管者汇报给管理者时，summary 只能是近况四行，briefPath 是近况路径；四行不齐不会写入收件箱，也不会叫醒管理者。detailPath 只能是详细记录的路径。",
    inputSchema: {
      type: "object",
      properties: {
        windowId: { type: "string", description: "上级窗口 id。缺省为直接上级。" },
        status: { type: "string", enum: [...REPORT_STATUS_ENUM], description: "汇报状态。" },
        summary: { type: "string", description: "摘要。" },
        files: {
          type: "array",
          items: { type: "string" },
          description: "相关文件的项目内相对路径。",
        },
        briefPath: { type: "string", description: "可选，项目 .ffpane/briefs/ 内的说明路径。" },
        detailPath: {
          type: "string",
          description:
            "可选。监管者交给管理者时，详细记录的路径，必须在 .ffpane/briefs/ 内。不要把正文放进来。",
        },
        closeAfter: {
          type: "boolean",
          description:
            "可选。只用于 done：汇报送出后几秒，由上级关闭本窗口。说明里要求做完自关时才用。管理者不能用。",
        },
      },
      required: ["status", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_read_inbox",
    description:
      "读取本窗口自己的收件箱。不能读别人的。mode=unread 只返回未读，mode=all 返回最近若干条。读取即标记已读。",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["unread", "all"],
          description: "unread 或 all，缺省 unread。",
        },
        limit: { type: "number", description: "最多返回条数，缺省 20，最大 50。" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_read_output",
    description:
      "读取后代窗口最近的终端输出。仅后代。缺省 mode=screen：按终端重放后返回屏幕上最后若干行文字，加载动画只留最后一帧，缺省 60 行，最多 300 行。mode=raw 返回原始回放尾部（已去掉 ANSI 和控制序列），默认 8KB，可用 maxBytes 调整，上限 32KB。窗口未运行时返回状态说明，而不是终端正文。",
    inputSchema: {
      type: "object",
      properties: {
        windowId: { type: "string", description: "后代窗口 id。" },
        mode: {
          type: "string",
          enum: ["screen", "raw"],
          description: "screen 渲染后的屏幕文字（缺省）；raw 原始回放尾部。",
        },
        lines: { type: "number", description: "screen 模式返回的行数，缺省 60，最大 300。" },
        maxBytes: {
          type: "number",
          description: "raw 模式读取尾部的字节数，缺省 8192，最大 32768。",
        },
      },
      required: ["windowId"],
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_close_window",
    description:
      "关闭后代窗口。仅后代。会结束该窗口的终端、吊销它的身份令牌，并把它从布局里移除。它的子窗口保留，并标记为父级已关闭，权限仍按开启时的上限封顶。不能用来关闭自己、上级或兄弟。",
    inputSchema: {
      type: "object",
      properties: {
        windowId: { type: "string", description: "要关闭的后代窗口 id。" },
      },
      required: ["windowId"],
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_open_panel",
    description:
      "在工作台打开隐藏抽屉的计划、任务看板或运行记录页签。任何窗口都可以调用。参数为 plan、tasks 或 runs。不在工作台时会先切到本窗口的项目。并提示是由哪个窗口打开的。调用过于频繁会被拒绝。",
    inputSchema: {
      type: "object",
      properties: {
        panel: {
          type: "string",
          enum: [...PANEL_ENUM],
          description: "plan、tasks 或 runs。",
        },
      },
      required: ["panel"],
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_open_canvas",
    description:
      "打开本项目的画板，并把指定图片放上去。图片路径必须在 .ffpane/canvas/ 内。要看图、改图或生图前先调用；新图请先存到 .ffpane/canvas/ 再打开。可选 rowId 与 asNewVersion：为 true 时在同一行横向追加版本。用户对不满意的生图打过标签后，返回值里的 revision 就是修改要求：marks 里是编号、位置、颜色和用户写的字，markedImage 是带这些绘制的预览图。同名文件在 .ffpane/canvas/revisions/。改图时要读这些文字，也要看 markedImage；按 image 指向的原图来画，不要把气泡和字画进新图。任何窗口都可调用。过于频繁会被拒绝。",
    inputSchema: {
      type: "object",
      properties: {
        imagePath: {
          type: "string",
          description: "项目内相对路径，例如 .ffpane/canvas/sketch.png。",
        },
        rowId: {
          type: "string",
          description: "可选。指定行 id，配合 asNewVersion 横向追加版本。",
        },
        asNewVersion: {
          type: "boolean",
          description: "为 true 时在 rowId 对应行追加新版本。",
        },
      },
      required: ["imagePath"],
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_generate_image",
    description:
      "按设置里的生图方案出一张新图，或按原图改一张。任何窗口都可调用。图写入当前项目的 .ffpane/canvas/ 并打开画板。不要自己另找生图办法。sourceImagePath 可选，有则改这张已有的图，路径必须在该项目 .ffpane/canvas/ 内，且不能是 revisions 里的派生文件。有原图并且传了 rowId 与 asNewVersion 时，新图挂到那一行；否则新开一行。设置若是先不生图，会失败。失败只返回原因，不往别的窗口写正文。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "用户要的画面。" },
        sourceImagePath: {
          type: "string",
          description: "可选。要修改的原图，必须在 .ffpane/canvas/ 内。",
        },
        rowId: {
          type: "string",
          description: "可选。有原图时配合 asNewVersion，把新图挂到这一行。",
        },
        asNewVersion: {
          type: "boolean",
          description: "为 true 且同时有原图和 rowId 时，在该行追加新版本。",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_delete_canvas_file",
    description:
      "申请删掉画板上的一张图。画板是项目图库：用户标过「不要」的图会移到画板回收站；没标的不会删，只在图上挂一条申请，等用户确认。图不会从磁盘直接删掉。要把图放进项目目录请用 ffpane_export_canvas_image，不要「复制再删」。",
    inputSchema: {
      type: "object",
      properties: {
        imagePath: {
          type: "string",
          description: "要删的图片，路径必须在 .ffpane/canvas/ 内。",
        },
        reason: {
          type: "string",
          description: "为什么要删（用户会在画板上看到）。",
        },
      },
      required: ["imagePath", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_export_canvas_image",
    description:
      "把画板上的一张图复制到项目里的指定位置（比如美术目录），原图留在画板，画板上会记下导出到哪里。targetPath 是项目里的相对路径，不能出项目、不能放进 .ffpane，扩展名要和原图一致。目标已有文件时要传 overwrite: true 才覆盖。",
    inputSchema: {
      type: "object",
      properties: {
        imagePath: {
          type: "string",
          description: "画板上的图，路径必须在 .ffpane/canvas/ 内。",
        },
        targetPath: {
          type: "string",
          description: "项目里的相对路径，例如 art/concept/00_aerial.png。",
        },
        overwrite: {
          type: "boolean",
          description: "目标已有文件时是否覆盖。缺省 false。",
        },
      },
      required: ["imagePath", "targetPath"],
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_memory_search",
    description:
      "检索本窗口所属项目的记忆（已生效的和待审核候选）。任何窗口都可以调用。只会查你自己的项目，参数里的项目路径会被忽略。一次最多 20 条，标题加正文合计不超过 16KB。可能依赖以前的决定、规则或教训时先查。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "要查的词或一句话。不能为空，最多 200 字。" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_memory_add",
    description:
      "新增一条本项目记忆候选（decision 决策 / rule 规则 / lesson 教训）。写入后出现在记忆页，带来源窗口，用户可以删除；用户通过后才会进入旧的自动注入。只有已授权的管理者，或用户自己打开且没有被冷启动清洗锁住的窗口可以调用。其它窗口请用 ffpane_report 请上级添加，不要反复尝试。标题最多 120 字，正文最多 2000 字。同一窗口至少间隔 10 秒。",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [...MEMORY_CATEGORY_ENUM],
          description: "decision、rule 或 lesson。",
        },
        title: { type: "string", description: "一句话标题。" },
        body: { type: "string", description: "正文。换行会保留。" },
      },
      required: ["category", "title", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_set_model_effort",
    description:
      "改某个窗口的模型或思考强度。只填要改的那一项，另一项保持原样。改完记在那个窗口上，由平台自己让它生效，不用窗口在当前标签页：还没聊过天就直接冷重启；聊过、能续接就带新参数续接；Codex 续接不了就在窗口里用 /model 只改本会话（不写用户的 config.toml）。窗口正忙就排队，空闲后自动做，生效后给你发一条「[模型]」提醒；同一窗口新的请求会覆盖还没生效的旧请求。返回的 status 是 已生效 / 仅记录 / 排队中 / 等用户确认，已生效时带上实际的模型和思考强度。管理者窗口和全放开窗口重启前要等用户确认。都做不到时只记下，下次启动生效；只读窗口可以再用 ffpane_restart_window 重启。不能用来改别的管理者。模型名只能是字母、数字和 . _ : @ / -，可以带 [1m] 这类后缀，最多 128 个字符。思考强度只能是 none、minimal、low、medium、high、xhigh、max。",
    inputSchema: {
      type: "object",
      properties: {
        windowId: { type: "string", description: "目标窗口 id。改自己时填自己的 id。" },
        model: { type: "string", description: "新模型名。不填则不改模型。" },
        reasoningEffort: {
          type: "string",
          description: "新的思考强度。不填则不改强度。",
        },
      },
      required: ["windowId"],
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_set_permission",
    description:
      "改后代窗口的权限，不用关掉重开。不得高于你自己的权限，不能改自己和上级。改完记在那个窗口上：空闲时自动续接重启，上下文保留；正忙就排队。改成全放开（yolo）时不自动重启，要等用户确认。会话还不能续接时，留给下次手动重启。",
    inputSchema: {
      type: "object",
      properties: {
        windowId: { type: "string", description: "后代窗口 id。" },
        permission: {
          type: "string",
          enum: [...PERMISSION_ENUM],
          description: "新权限。",
        },
      },
      required: ["windowId", "permission"],
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_broadcast",
    description:
      "一次给全部后代（缺省）或直接子窗口发同一条消息，例如全体暂停或改规则。每个窗口各写一条收件箱记录并提醒，返回每个窗口的投递状态。正文上限 8KB，长内容写 brief 后只传 briefPath。之后用 ffpane_list_windows 看谁已经空闲。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "消息正文。" },
        briefPath: { type: "string", description: "可选，项目 .ffpane/briefs/ 内的说明路径。" },
        scope: {
          type: "string",
          enum: ["descendants", "children"],
          description: "descendants 全部后代（缺省）；children 只发直接子窗口。",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ffpane_lock",
    description:
      "本项目的命名锁，给一台机器只能开一个的资源排队（如 unity）。acquire 拿锁：空着就拿到，有人占着就排队，轮到你时收到「[锁]」提醒，排队时结束本轮等提醒、不要轮询。release 放锁或退出排队，下一个排队的窗口自动拿到。窗口退出或被关闭时它的锁自动放掉。list 列出谁持有、谁在排队。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["acquire", "release", "list"],
          description: "acquire、release 或 list。",
        },
        name: {
          type: "string",
          description: "锁名，1 到 64 个字母、数字、点、下划线或减号。list 时不填。",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];

export const WORKBENCH_MCP_TOOLS: readonly McpToolDefinition[] = TOOL_DEFINITIONS.map((tool) =>
  (WORKBENCH_READ_ONLY_TOOL_NAMES as readonly string[]).includes(tool.name)
    ? { ...tool, annotations: { readOnlyHint: true } }
    : tool,
);
