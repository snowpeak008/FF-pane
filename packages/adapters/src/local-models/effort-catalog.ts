/**
 * OpenCode 本机模型目录里的 effort values（T9.4b）。
 *
 * 路径：`~/.cache/opencode/models.json`（models.dev 缓存，见 opencode.md §4.3 / §10）。
 * 只认 `reasoning_options.type === "effort"` 的 `values`；读不到 / 空 / 仅 toggle
 * → 返回空目录或 undefined，UI 隐藏且不下发。
 * 纯解析可单测；读盘失败视为「读不到」。
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** OpenCode 本机模型目录默认路径。 */
export function defaultOpenCodeModelsPath(): string {
  return path.join(homedir(), ".cache", "opencode", "models.json");
}

/**
 * 从已解析的目录 JSON 取出某模型的 effort values。
 * - `undefined`：目录里找不到该模型（或未给 modelId）
 * - `[]`：找到了但没有 effort 类型 / values 为空
 * - 非空：该模型声明的档位（可能含非规范值，调用方再与规范档求交）
 */
export function parseOpenCodeEffortValues(
  catalog: unknown,
  modelId: string | undefined,
): readonly string[] | undefined {
  if (modelId === undefined || modelId.trim() === "") {
    return undefined;
  }
  const wanted = modelId.trim();
  const byKey = findModelNodeByKey(catalog, wanted);
  if (byKey !== undefined) {
    return extractEffortValues(byKey) ?? [];
  }
  const found = findModelRecord(catalog, wanted);
  if (found === undefined) {
    return undefined;
  }
  return extractEffortValues(found) ?? [];
}

/** 读本机 OpenCode 目录；文件缺失 / JSON 坏 / 模型对不上 → undefined。 */
export async function readOpenCodeEffortValues(
  modelId: string | undefined,
  options: { readonly catalogPath?: string } = {},
): Promise<readonly string[] | undefined> {
  const filePath = options.catalogPath ?? defaultOpenCodeModelsPath();
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return parseOpenCodeEffortValues(parsed, modelId);
}

function extractEffortValues(node: unknown): readonly string[] | undefined {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return undefined;
  }
  const record = node as Record<string, unknown>;
  const opts = record["reasoning_options"] ?? record["reasoningOptions"];
  if (opts === undefined) {
    return undefined;
  }
  if (Array.isArray(opts)) {
    for (const item of opts) {
      const values = effortValuesOf(item);
      if (values !== undefined) {
        return values;
      }
    }
    return [];
  }
  const direct = effortValuesOf(opts);
  if (direct !== undefined) {
    return direct;
  }
  if (opts !== null && typeof opts === "object" && !Array.isArray(opts)) {
    const nested = (opts as Record<string, unknown>)["effort"];
    if (Array.isArray(nested)) {
      return nested.filter((value): value is string => typeof value === "string");
    }
    const nestedValues = effortValuesOf(nested);
    if (nestedValues !== undefined) {
      return nestedValues;
    }
  }
  return [];
}

function effortValuesOf(item: unknown): readonly string[] | undefined {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  if (record["type"] !== "effort" && record["type"] !== "reasoning_effort") {
    return undefined;
  }
  const values = record["values"] ?? record["options"];
  if (!Array.isArray(values)) {
    return [];
  }
  return values.filter((value): value is string => typeof value === "string");
}

function findModelNodeByKey(catalog: unknown, modelId: string): unknown {
  if (catalog === null || typeof catalog !== "object") {
    return undefined;
  }
  if (Array.isArray(catalog)) {
    return undefined;
  }
  const record = catalog as Record<string, unknown>;
  if (modelId in record) {
    return record[modelId];
  }
  const last = lastSegment(modelId);
  if (last !== modelId && last in record) {
    return record[last];
  }
  const slash = modelId.indexOf("/");
  if (slash > 0) {
    const provider = record[modelId.slice(0, slash)];
    if (provider !== null && typeof provider === "object" && !Array.isArray(provider)) {
      const providerRec = provider as Record<string, unknown>;
      const models = providerRec["models"] ?? provider;
      if (models !== null && typeof models === "object" && !Array.isArray(models)) {
        const modelsRec = models as Record<string, unknown>;
        if (last in modelsRec) {
          return modelsRec[last];
        }
      }
    }
  }
  return undefined;
}

function findModelRecord(catalog: unknown, modelId: string): Record<string, unknown> | undefined {
  let matched: Record<string, unknown> | undefined;
  walkModelRecords(catalog, (entry) => {
    if (matched === undefined && modelMatches(entry, modelId)) {
      matched = entry;
    }
  });
  return matched;
}

function walkModelRecords(node: unknown, visit: (entry: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      walkModelRecords(item, visit);
    }
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  const record = node as Record<string, unknown>;
  if (looksLikeModelRecord(record)) {
    visit(record);
  }
  if (record["models"] !== undefined) {
    walkModelRecords(record["models"], visit);
    return;
  }
  for (const value of Object.values(record)) {
    if (value !== null && typeof value === "object") {
      walkModelRecords(value, visit);
    }
  }
}

function looksLikeModelRecord(record: Record<string, unknown>): boolean {
  return (
    typeof record["id"] === "string" ||
    typeof record["modelID"] === "string" ||
    typeof record["modelId"] === "string" ||
    record["reasoning_options"] !== undefined ||
    record["reasoningOptions"] !== undefined
  );
}

function modelMatches(entry: Record<string, unknown>, modelId: string): boolean {
  const ids = collectModelIds(entry);
  if (ids.has(modelId)) {
    return true;
  }
  const last = lastSegment(modelId);
  if (last !== modelId && ids.has(last)) {
    return true;
  }
  if (!modelId.includes("/")) {
    for (const id of ids) {
      if (lastSegment(id) === modelId) {
        return true;
      }
    }
  }
  return false;
}

function collectModelIds(entry: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const id = typeof entry["id"] === "string" ? entry["id"] : undefined;
  const providerID =
    typeof entry["providerID"] === "string"
      ? entry["providerID"]
      : typeof entry["providerId"] === "string"
        ? entry["providerId"]
        : undefined;
  const modelID =
    typeof entry["modelID"] === "string"
      ? entry["modelID"]
      : typeof entry["modelId"] === "string"
        ? entry["modelId"]
        : undefined;
  if (id !== undefined) {
    ids.add(id);
  }
  if (modelID !== undefined) {
    ids.add(modelID);
  }
  if (providerID !== undefined && modelID !== undefined) {
    ids.add(`${providerID}/${modelID}`);
  }
  return ids;
}

function lastSegment(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}
