/**
 * 会话登记表持久化与 CRUD（T4.3）：设计文档 §10.2 规则 3 / §10.3。
 *
 * 职责边界：工作台**只登记** Local Session ID ↔ Native Session ID 的映射与会话元数据
 * （承载 Profile、角色、原生绑定、恢复方式、活跃时间），**不复制会话内容**——会话原始
 * 记录归 Agent 自己。故本层持久化的是 SessionRecord（无消息正文），供：
 * - 原生恢复：按登记的 NativeSessionBinding（ID + cwd 成对）续接原生会话；
 * - 上下文重建：Runtime 不支持原生恢复时，据此重建计划/任务/state/Run 上下文。
 *
 * 设计沿用 providers 层：整文件 `{ version, sessions[] }` 原子读写；文件不存在视为空集
 * （首次使用路径，首个 saveSession 自动落盘建档）；JSON 语法损坏由 W1.2a 隔离，本层把
 * StorageCorruptJsonError 原样上抛，下次读取回到干净空集；结构/字段不符抛
 * SessionsFileInvalidError（不隔离，留在原地人工修复）。
 *
 * 并发：主进程编排器是唯一写者（每轮串行 upsert），无并发写竞争。
 */

import type { SessionRecord } from "@ff-pane/shared";
import { isRole, isSessionResumeKind } from "@ff-pane/shared";
import { readJson, writeJsonAtomic } from "../fs/index.js";
import { SessionsFileInvalidError } from "./errors.js";

/** sessions.json 的当前格式版本。未来格式变更时在读入处显式迁移。 */
export const SESSIONS_FILE_VERSION = 1;

/** sessions.json 的整文件结构：版本字段 + 条目数组。 */
export interface SessionsFile {
  /** 文件格式版本（当前恒为 SESSIONS_FILE_VERSION）。 */
  readonly version: typeof SESSIONS_FILE_VERSION;
  /** 全部会话登记条目。 */
  readonly sessions: readonly SessionRecord[];
}

/** 会话登记存取接口（消费方：T4.2/T4.3 会话编排器、会话页会话列表）。 */
export interface SessionStore {
  /** 列出全部会话登记，按 lastActiveAt 降序（最近活跃在前，供会话列表直用）。 */
  listSessions(): Promise<readonly SessionRecord[]>;
  /** 按 Local Session ID 查询。不存在返回 undefined（查询是常态分支，不抛错）。 */
  getSession(id: SessionRecord["id"]): Promise<SessionRecord | undefined>;
  /** 落位一条会话登记（按 id upsert：已存在则整条替换，否则追加）。 */
  saveSession(record: SessionRecord): Promise<void>;
  /** 删除一条会话登记。返回是否命中删除。 */
  deleteSession(id: SessionRecord["id"]): Promise<boolean>;
}

/** 读入边界字段校验：仅校验会破坏后续消费的判别字段（role / resumeKind）。 */
function validateRecord(record: SessionRecord, path: string): SessionRecord {
  if (!isRole(record.role)) {
    throw new SessionsFileInvalidError(
      path,
      `会话 ${record.id} 的 role 非法：${String(record.role)}`,
    );
  }
  if (record.resumeKind !== undefined && !isSessionResumeKind(record.resumeKind)) {
    throw new SessionsFileInvalidError(
      path,
      `会话 ${record.id} 的 resumeKind 非法：${String(record.resumeKind)}`,
    );
  }
  return record;
}

/** 读入整文件并做结构 + 条目边界检查。not-found 归一为空集，其余失败抛 typed error。 */
async function loadSessions(sessionsFile: string): Promise<readonly SessionRecord[]> {
  const result = await readJson<unknown>(sessionsFile);
  if (!result.ok) {
    if (result.error.code === "not-found") {
      return [];
    }
    throw result.error;
  }
  const raw = result.value;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SessionsFileInvalidError(sessionsFile, "顶层必须是对象");
  }
  const file = raw as { readonly version?: unknown; readonly sessions?: unknown };
  if (file.version !== SESSIONS_FILE_VERSION) {
    throw new SessionsFileInvalidError(
      sessionsFile,
      `不支持的 version：${String(file.version)}（当前支持 ${SESSIONS_FILE_VERSION}）`,
    );
  }
  if (!Array.isArray(file.sessions)) {
    throw new SessionsFileInvalidError(sessionsFile, "sessions 必须是数组");
  }
  // JSON 边界：条目写入时已成型，按 W1.1 约定 as 断言收窄品牌类型后逐条校验判别字段
  return (file.sessions as readonly SessionRecord[]).map((record) =>
    validateRecord(record, sessionsFile),
  );
}

/** 整文件原子写回（版本字段 + 条目数组）。 */
async function saveSessions(
  sessionsFile: string,
  sessions: readonly SessionRecord[],
): Promise<void> {
  const file: SessionsFile = { version: SESSIONS_FILE_VERSION, sessions };
  await writeJsonAtomic(sessionsFile, file);
}

function byLastActiveDesc(a: SessionRecord, b: SessionRecord): number {
  if (a.lastActiveAt !== b.lastActiveAt) {
    return b.lastActiveAt - a.lastActiveAt;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 创建绑定到指定 sessions.json 路径的 SessionStore。
 * 路径由宿主注入（接线示例：`createSessionStore(resolveProjectLayout(root).sessionsFile)`），
 * 与 W1.2a 布局层「根目录一律参数注入」的约定一致。
 */
export function createSessionStore(sessionsFile: string): SessionStore {
  return {
    async listSessions(): Promise<readonly SessionRecord[]> {
      const sessions = await loadSessions(sessionsFile);
      return sessions.toSorted(byLastActiveDesc);
    },

    async getSession(id: SessionRecord["id"]): Promise<SessionRecord | undefined> {
      const sessions = await loadSessions(sessionsFile);
      return sessions.find((session) => session.id === id);
    },

    async saveSession(record: SessionRecord): Promise<void> {
      const sessions = await loadSessions(sessionsFile);
      const index = sessions.findIndex((session) => session.id === record.id);
      await saveSessions(
        sessionsFile,
        index === -1 ? [...sessions, record] : sessions.with(index, record),
      );
    },

    async deleteSession(id: SessionRecord["id"]): Promise<boolean> {
      const sessions = await loadSessions(sessionsFile);
      if (!sessions.some((session) => session.id === id)) {
        return false;
      }
      await saveSessions(
        sessionsFile,
        sessions.filter((session) => session.id !== id),
      );
      return true;
    },
  };
}
