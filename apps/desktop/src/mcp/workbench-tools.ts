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
  "ffpane_memory_search",
  "ffpane_memory_add",
  "ffpane_set_model_effort",
  "ffpane_set_permission",
  "ffpane_broadcast",
  "ffpane_lock",
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
];

const TOOL_DEFINITIONS: readonly McpToolDefinition[] = [
  {
    name: "ffpane_whoami",
    description:
      "返回本窗口的 id、标题、角色、权限、上级（id 与标题）、项目名与项目根目录。任何窗口都可调用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ffpane_list_windows",
    description:
      "列出本窗口可见的窗口：自己、自己的后代、以及上级链。不含兄弟和无关窗口。每项含角色、权限、是否在运行、最近一次汇报状态。",
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
      "从磁盘删除 .ffpane/canvas/ 内的一张图片，并同步从画板数据移除。只有用户在对话里明确说要清理文件时才调用；不要自动删。",
    inputSchema: {
      type: "object",
      properties: {
        imagePath: {
          type: "string",
          description: "要删除的图片，路径必须在 .ffpane/canvas/ 内。",
        },
      },
      required: ["imagePath"],
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
      "改某个窗口的模型或思考强度。只填要改的那一项，另一项保持原样。改完记在那个窗口上：空闲时自动续接重启并带上新参数；窗口正忙就排队，同一窗口新的请求会覆盖还没生效的旧请求。管理者窗口和全放开窗口不会自动重启，要等用户确认。会话还不能续接时不会硬重启，留给下次手动重启。不能用来改别的管理者。模型名只能是字母、数字和 . _ : @ / -，可以带 [1m] 这类后缀，最多 128 个字符。思考强度只能是 none、minimal、low、medium、high、xhigh、max。",
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
