/**
 * Agent CLI 子进程管理层（W2.1a）barrel。
 *
 * 提供三件事：spawn 封装（含 Windows .cmd 垫片）、环境变量清洗、进程树终止。
 * 不含任何 CLI 协议知识——行切分与事件解析见 events/（W2.1b），适配器接口见
 * W2.1c。
 */

export {
  type AgentEnvOptions,
  type AgentEnvResult,
  API_KEY_ENV_PATTERNS,
  buildAgentEnv,
  isApiKeyEnvName,
} from "./env.js";
export {
  type KillTreeOutcome,
  killProcessTree,
  TASKKILL_PROCESS_NOT_FOUND_EXIT_CODE,
} from "./kill-tree.js";
export { EXIT_SETTLE_GRACE_MS, KILL_CONFIRM_TIMEOUT_MS, spawnAgentProcess } from "./spawn.js";
export { ByteChunkQueue, DEFAULT_STREAM_HIGH_WATER_MARK } from "./stream.js";
export type {
  AgentProcessEndKind,
  AgentProcessExit,
  AgentProcessHandle,
  AgentProcessSpec,
  AgentStdinMode,
} from "./types.js";
export {
  buildCmdShimCommandLine,
  findExecutableOnWindowsPath,
  resolveSpawnTarget,
  type SpawnTarget,
} from "./windows-command.js";
