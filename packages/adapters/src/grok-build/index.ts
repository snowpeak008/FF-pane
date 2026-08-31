/** Grok Build 适配器（T7.3）barrel：命令行组装、事件映射、diff 渲染、适配器本体。 */

export {
  createGrokBuildAdapter,
  GROK_BUILD_CAPABILITIES,
  type GrokBuildAdapter,
  type GrokBuildAdapterOptions,
  type GrokBuildTurn,
} from "./adapter.js";
export {
  buildGrokArgs,
  DEFAULT_GROK_COMMAND,
  DEFAULT_GROK_PERMISSION_MODE,
  GROK_BUILD_RUNTIME,
  GROK_PERMISSION_MODES,
  type GrokArgsInput,
  type GrokPermissionMode,
} from "./command.js";
export {
  firstDiffPath,
  type GrokDiffInput,
  renderGrokDiff,
  renderGrokDiffFromContent,
} from "./diff.js";
export {
  createGrokEventMapper,
  type GrokEventMapper,
  type GrokEventMapperOptions,
  type GrokStreamOutcome,
} from "./mapper.js";
