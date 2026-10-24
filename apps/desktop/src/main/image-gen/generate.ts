/**
 * 工作台出图：任何窗口经 ffpane_generate_image 走这里。
 *
 * 中转站把 PNG 直接写进当前项目的 .ffpane/canvas/。
 * Codex 订阅没有可指定的输出路径（内置 image_gen 不认目标目录），
 * 图先落在 CODEX_HOME/generated_images/<会话 id>/（没有 CODEX_HOME 则是用户主目录下的 .codex）。
 * 会话 id 从 codex exec --json 的 thread.started 读出；旧版直接落在 generated_images 这一层，也认。
 * 进程结束后只搬走这一次新出现的 PNG，并从那个目录删掉这一张。
 * 临时目录不是 git 仓库，必须带 --skip-git-repo-check，否则 Codex 一启动就退出。
 * 不读、不改 auth.json 和 config.toml。不设置 CODEX_HOME。环境里拿掉 OPENAI_。
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { buildAgentEnv, resolveDirectCliTarget } from "@ff-pane/adapters";
import { redactSecret } from "@ff-pane/core";
import { imageGenModeOf } from "@ff-pane/shared";
import {
  describeCanvasRevision,
  lexicalCanvasPath,
  placeImageOnBoard,
  resolveCanvasImage,
} from "../workbench/canvas-files";
import type { CanvasRevisionForTool } from "../workbench/canvas-revision";
import { editImagePng, generateImagePng } from "./openai-images";
import type { ImageGenStores } from "./settings";

export const IMAGE_GEN_OFF_ERROR = "设置里还是「先不生图」，现在不能出新图。";
export const IMAGE_GEN_RELAY_INCOMPLETE_ERROR = "生图中转站还没保存完整，不能出图。";
export const IMAGE_GEN_KEY_UNREADABLE_ERROR = "已保存的密钥读不出来，请到设置里重新保存后再试。";
export const IMAGE_GEN_PROMPT_ERROR = "ffpane_generate_image 需要 prompt（要画的画面）。";
export const IMAGE_GEN_CODEX_MISSING_ERROR = "找不到 Codex，无法出图。";
export const IMAGE_GEN_CODEX_NO_IMAGE_ERROR = "Codex 没有出图。";
export const IMAGE_GEN_CODEX_SHELL_ERROR = "Codex 出图不能经 cmd 启动。";

const CODEX_IMAGE_TIMEOUT_MS = 180_000;
const CODEX_REASON_MAX = 300;
const CODEX_STDERR_KEEP = 4000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** 假进程测试注入的启动请求。shell 固定为 false。 */
export interface CodexImageLaunch {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
}

/** 这一次 codex exec 交回来的东西：会话 id 用来找图，reason 用来在没出图时告诉用户为什么。 */
export interface CodexImageRun {
  readonly threadId?: string;
  readonly reason?: string;
}

export interface GenerateProjectImageInput {
  readonly projectRoot: string;
  readonly prompt: string;
  readonly sourceImagePath?: string;
  readonly rowId?: string;
  readonly asNewVersion?: boolean;
}

export interface GenerateProjectImageDeps {
  readonly stores: ImageGenStores;
  readonly fetchImpl?: typeof fetch;
  /** 缺省是当前进程环境。测试传入，避免碰到真实用户目录。 */
  readonly baseEnv?: NodeJS.ProcessEnv;
  /** CODEX_HOME 未设置时用它代替 os.homedir()。测试指向临时目录。 */
  readonly homeDir?: string;
  readonly launchCodex?: (launch: CodexImageLaunch) => Promise<CodexImageRun>;
}

export type GenerateProjectImageResult =
  | { readonly ok: true; readonly relativePath: string }
  | { readonly ok: false; readonly error: string };

interface CleanInput {
  readonly projectRoot: string;
  readonly prompt: string;
  readonly sourceImagePath?: string;
  readonly rowId?: string;
  readonly asNewVersion: boolean;
}

function failure(error: string, secret = ""): GenerateProjectImageResult {
  return { ok: false, error: redactSecret(error, secret) };
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : "出图失败";
}

/** 有 CODEX_HOME 就用它，否则用主目录下的 .codex。只拼 generated_images 这一层。 */
export function codexGeneratedImagesDir(env: NodeJS.ProcessEnv, homeDir?: string): string {
  const configured = env["CODEX_HOME"]?.trim() ?? "";
  const root = configured !== "" ? configured : join(homeDir ?? homedir(), ".codex");
  return join(root, "generated_images");
}

/** 会话 id 只允许字母、数字、横线、下划线，拼路径时跑不出 generated_images。 */
function codexThreadImagesDir(imagesDir: string, threadId: string | undefined): string | undefined {
  const id = threadId?.trim() ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    return undefined;
  }
  return join(imagesDir, id);
}

function shortReason(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= CODEX_REASON_MAX ? flat : `${flat.slice(0, CODEX_REASON_MAX)}…`;
}

/**
 * 逐行读 codex exec --json 的输出，只留会话 id、最后一条报错、最后一句回复。
 * stderr 只留尾巴，去掉「Reading additional input from stdin...」这种提示。
 */
export function createCodexOutputReader(): {
  readonly pushStdout: (chunk: string) => void;
  readonly pushStderr: (chunk: string) => void;
  readonly result: (extraReason?: string) => CodexImageRun;
} {
  let pending = "";
  let stderrTail = "";
  let threadId: string | undefined;
  let errorMessage = "";
  let lastAgentMessage = "";

  const readLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = event["type"];
    if (type === "thread.started" && typeof event["thread_id"] === "string") {
      threadId = event["thread_id"];
    } else if (type === "error" && typeof event["message"] === "string") {
      errorMessage = event["message"];
    } else if (type === "turn.failed") {
      const error = event["error"];
      const message =
        typeof error === "object" && error !== null
          ? (error as Record<string, unknown>)["message"]
          : undefined;
      if (typeof message === "string") {
        errorMessage = message;
      }
    } else if (type === "item.completed") {
      const item = event["item"];
      if (typeof item === "object" && item !== null) {
        const record = item as Record<string, unknown>;
        if (record["type"] === "agent_message" && typeof record["text"] === "string") {
          lastAgentMessage = record["text"];
        }
      }
    }
  };

  return {
    pushStdout: (chunk) => {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        readLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    },
    pushStderr: (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-CODEX_STDERR_KEEP);
    },
    result: (extraReason) => {
      if (pending !== "") {
        readLine(pending);
        pending = "";
      }
      const stderrText = stderrTail
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(
          (line) => line !== "" && !/^Reading (additional )?(input|prompt) from stdin/i.test(line),
        )
        .slice(-3)
        .join(" ");
      const reason = [extraReason ?? "", errorMessage, stderrText, lastAgentMessage].find(
        (text) => text.trim() !== "",
      );
      return {
        ...(threadId !== undefined ? { threadId } : {}),
        ...(reason !== undefined ? { reason: shortReason(reason) } : {}),
      };
    },
  };
}

function noImageFailure(reason: string | undefined): GenerateProjectImageResult {
  const text = reason?.trim() ?? "";
  return failure(
    text === ""
      ? IMAGE_GEN_CODEX_NO_IMAGE_ERROR
      : `${IMAGE_GEN_CODEX_NO_IMAGE_ERROR}Codex 说：${text}`,
  );
}

function isForbiddenLauncher(file: string): boolean {
  const name = basename(file).toLowerCase();
  return (
    name === "cmd" ||
    name === "cmd.exe" ||
    name === "powershell" ||
    name === "powershell.exe" ||
    name === "pwsh" ||
    name === "pwsh.exe" ||
    name.endsWith(".cmd") ||
    name.endsWith(".bat")
  );
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function versionOptions(input: CleanInput): {
  readonly rowId?: string;
  readonly asNewVersion?: boolean;
} {
  const rowId = input.rowId?.trim() ?? "";
  if (input.sourceImagePath === undefined || rowId === "" || input.asNewVersion !== true) {
    return {};
  }
  return { rowId, asNewVersion: true };
}

function formatRevision(revision: CanvasRevisionForTool | undefined): string {
  if (revision === undefined || revision.marks.length === 0) {
    return "";
  }
  const lines = ["修改要求："];
  for (const mark of revision.marks) {
    const number = mark.number === undefined ? "" : String(mark.number);
    const text = mark.text?.trim() ?? "";
    const position = `x=${mark.x} y=${mark.y}`;
    lines.push(
      text === ""
        ? `编号 ${number}，位置 ${position}`
        : `编号 ${number}，位置 ${position}：${text}`,
    );
  }
  lines.push("不要把气泡画进新图。");
  return lines.join("\n");
}

function relayPrompt(prompt: string, revisionNote: string): string {
  if (revisionNote === "") {
    return prompt;
  }
  return `${prompt}\n\n${revisionNote}`;
}

function codexPrompt(
  prompt: string,
  sourceAbsolute: string | undefined,
  revisionNote: string,
): string {
  const lines = ["请用内置的 image_gen 出一张 PNG。", "不要改代码，不要写脚本。", "画面：", prompt];
  if (sourceAbsolute !== undefined) {
    lines.push(
      "要修改的原图是这个文件，按原图改，不要把带标记的预览当成要修改的原图：",
      sourceAbsolute,
    );
  }
  if (revisionNote !== "") {
    lines.push(revisionNote);
  }
  lines.push("不要改代码。");
  return lines.join("\n");
}

async function allocateCanvasPng(
  projectRoot: string,
): Promise<
  | { readonly ok: true; readonly absolute: string; readonly relative: string }
  | { readonly ok: false; readonly error: string }
> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const name = `gen-${randomUUID()}.png`;
    const lexical = lexicalCanvasPath(projectRoot, `.ffpane/canvas/${name}`);
    if (!lexical.ok) {
      return lexical;
    }
    try {
      await lstat(lexical.absolute);
    } catch {
      return { ok: true, absolute: lexical.absolute, relative: lexical.relative };
    }
  }
  return { ok: false, error: "没能写下新的图片文件名。" };
}

async function placeNewImage(
  projectRoot: string,
  relativePath: string,
  input: CleanInput,
  secret: string,
): Promise<GenerateProjectImageResult> {
  try {
    const placed = await placeImageOnBoard(projectRoot, relativePath, versionOptions(input));
    if (!placed.ok) {
      return failure(placed.error, secret);
    }
    if (secret !== "" && placed.relativePath.includes(secret)) {
      return failure("出图结果异常。", secret);
    }
    return { ok: true, relativePath: placed.relativePath };
  } catch (error) {
    return failure(messageOf(error), secret);
  }
}

async function writePngInCanvas(
  projectRoot: string,
  bytes: Uint8Array,
): Promise<
  { readonly ok: true; readonly relative: string } | { readonly ok: false; readonly error: string }
> {
  const target = await allocateCanvasPng(projectRoot);
  if (!target.ok) {
    return target;
  }
  await mkdir(dirname(target.absolute), { recursive: true });
  const temp = join(dirname(target.absolute), `.${basename(target.absolute)}.tmp`);
  await writeFile(temp, bytes);
  try {
    await rename(temp, target.absolute);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  return { ok: true, relative: target.relative };
}

/** 只列出这一层的文件名，不读内容。目录不存在就当空的，不去创建。 */
async function listFileNames(dir: string): Promise<ReadonlySet<string>> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = new Set<string>();
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        continue;
      }
      if (entry.name.includes("/") || entry.name.includes("\\")) {
        continue;
      }
      files.add(entry.name);
    }
    return files;
  } catch {
    return new Set();
  }
}

async function isPngFile(absolute: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absolute, "r");
  } catch {
    return false;
  }
  try {
    const header = Buffer.alloc(PNG_SIGNATURE.length);
    const read = await handle.read(header, 0, header.length, 0);
    if (read.bytesRead < header.length) {
      return false;
    }
    return PNG_SIGNATURE.every((byte, index) => header[index] === byte);
  } finally {
    await handle.close();
  }
}

async function pickNewestNewPng(
  dir: string,
  before: ReadonlySet<string>,
): Promise<string | undefined> {
  const names = await listFileNames(dir);
  const candidates: { name: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (before.has(name) || !name.toLowerCase().endsWith(".png")) {
      continue;
    }
    const absolute = join(dir, name);
    const rel = relative(dir, absolute);
    if (rel.startsWith("..") || rel.includes(sep) || rel.includes("/")) {
      continue;
    }
    try {
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        continue;
      }
      candidates.push({ name, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
  for (const candidate of candidates) {
    if (await isPngFile(join(dir, candidate.name))) {
      return candidate.name;
    }
  }
  return undefined;
}

async function moveFile(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") {
      throw error;
    }
    await copyFile(source, destination);
    await unlink(source);
  }
}

/** 生产启动：shell 必须是 false，可执行文件不能是 cmd / PowerShell。 */
export function launchCodexImageProcess(launch: CodexImageLaunch): Promise<CodexImageRun> {
  if (launch.shell !== false || isForbiddenLauncher(launch.file)) {
    return Promise.reject(new Error(IMAGE_GEN_CODEX_SHELL_ERROR));
  }
  return new Promise((resolvePromise, reject) => {
    const reader = createCodexOutputReader();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (error?: Error, extraReason?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (error !== undefined) {
        reject(error);
      } else {
        resolvePromise(reader.result(extraReason));
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.file, [...launch.args], {
        cwd: launch.cwd,
        env: { ...launch.env },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      done(error instanceof Error ? error : new Error(IMAGE_GEN_CODEX_NO_IMAGE_ERROR));
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      reader.pushStdout(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      reader.pushStderr(chunk);
    });
    timer = setTimeout(() => {
      child.kill();
      done(undefined, `超过 ${CODEX_IMAGE_TIMEOUT_MS / 60_000} 分钟还没出图，已停止。`);
    }, CODEX_IMAGE_TIMEOUT_MS);
    child.once("error", (error) => {
      done(error);
    });
    child.once("close", () => {
      done();
    });
  });
}

async function runRelay(
  input: CleanInput,
  source: { readonly absolute: string; readonly bytes: Uint8Array } | undefined,
  revisionNote: string,
  deps: GenerateProjectImageDeps,
): Promise<GenerateProjectImageResult> {
  const settings = (await deps.stores.readConfig()).imageGen;
  const relay = settings?.relay;
  if (
    relay === undefined ||
    relay.baseUrl.trim() === "" ||
    relay.model.trim() === "" ||
    relay.apiKeyRef.trim() === "" ||
    !(await deps.stores.hasSecret(relay.apiKeyRef))
  ) {
    return failure(IMAGE_GEN_RELAY_INCOMPLETE_ERROR);
  }
  let apiKey = "";
  try {
    try {
      apiKey = await deps.stores.revealSecret(relay.apiKeyRef);
    } catch {
      return failure(IMAGE_GEN_KEY_UNREADABLE_ERROR);
    }
    if (apiKey.trim() === "") {
      return failure(IMAGE_GEN_RELAY_INCOMPLETE_ERROR);
    }
    const prompt = relayPrompt(input.prompt, revisionNote);
    const request = {
      baseUrl: relay.baseUrl,
      apiKey,
      model: relay.model,
      prompt,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    };
    const bytes =
      source === undefined
        ? await generateImagePng(request)
        : await editImagePng({ ...request, imagePng: source.bytes });
    const written = await writePngInCanvas(input.projectRoot, bytes);
    if (!written.ok) {
      return failure(written.error, apiKey);
    }
    return await placeNewImage(input.projectRoot, written.relative, input, apiKey);
  } catch (error) {
    return failure(messageOf(error), apiKey);
  } finally {
    apiKey = "";
  }
}

async function runCodex(
  input: CleanInput,
  sourceAbsolute: string | undefined,
  revisionNote: string,
  deps: GenerateProjectImageDeps,
): Promise<GenerateProjectImageResult> {
  const baseEnv = deps.baseEnv ?? process.env;
  const { env } = buildAgentEnv({ baseEnv, inject: {}, stripApiKeyEnv: true });
  const imagesDir = codexGeneratedImagesDir(env, deps.homeDir);
  const cliArgs = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    codexPrompt(input.prompt, sourceAbsolute, revisionNote),
  ];
  const target = resolveDirectCliTarget("codex", cliArgs, env);
  if (target === undefined || isForbiddenLauncher(target.file)) {
    return failure(
      target === undefined ? IMAGE_GEN_CODEX_MISSING_ERROR : IMAGE_GEN_CODEX_SHELL_ERROR,
    );
  }
  const launch: CodexImageLaunch = {
    file: target.file,
    args: target.args,
    cwd: "",
    env: stringEnv(env),
    shell: false,
  };
  let workDir: string | undefined;
  try {
    workDir = await createWorkDir();
    if (resolve(workDir) === resolve(input.projectRoot)) {
      return failure(IMAGE_GEN_CODEX_NO_IMAGE_ERROR);
    }
    const before = await listFileNames(imagesDir);
    const launchCodex = deps.launchCodex ?? launchCodexImageProcess;
    let run: CodexImageRun = {};
    try {
      run = await launchCodex({ ...launch, cwd: workDir });
    } catch (error) {
      // 进程没正常结束也先看这一次有没有新图，没有再失败。
      run = { reason: shortReason(messageOf(error)) };
    }
    // 先找这次会话自己的文件夹，不碰别的会话的图；没有再按旧版去最外层找。
    const threadDir = codexThreadImagesDir(imagesDir, run.threadId);
    let source: string | undefined;
    if (threadDir !== undefined) {
      const picked = await pickNewestNewPng(threadDir, new Set());
      source = picked === undefined ? undefined : join(threadDir, picked);
    }
    if (source === undefined) {
      const picked = await pickNewestNewPng(imagesDir, before);
      source = picked === undefined ? undefined : join(imagesDir, picked);
    }
    if (source === undefined) {
      return noImageFailure(run.reason);
    }
    const allocated = await allocateCanvasPng(input.projectRoot);
    if (!allocated.ok) {
      return allocated;
    }
    await mkdir(dirname(allocated.absolute), { recursive: true });
    try {
      await moveFile(source, allocated.absolute);
    } catch {
      return failure("没能把图放进画板。");
    }
    if (threadDir !== undefined) {
      // 只删空文件夹；里面还有别的文件就留着。
      await rmdir(threadDir).catch(() => undefined);
    }
    return await placeNewImage(input.projectRoot, allocated.relative, input, "");
  } finally {
    if (workDir !== undefined) {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function createWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ffpane-image-"));
}

export async function generateProjectImage(
  input: GenerateProjectImageInput,
  deps: GenerateProjectImageDeps,
): Promise<GenerateProjectImageResult> {
  const prompt = input.prompt.trim();
  if (prompt === "") {
    return failure(IMAGE_GEN_PROMPT_ERROR);
  }
  const sourceImagePath = input.sourceImagePath?.trim();
  const clean: CleanInput = {
    projectRoot: input.projectRoot,
    prompt,
    ...(sourceImagePath !== undefined && sourceImagePath !== "" ? { sourceImagePath } : {}),
    ...(input.rowId !== undefined ? { rowId: input.rowId } : {}),
    asNewVersion: input.asNewVersion === true,
  };
  const settings = await deps.stores.readConfig();
  const mode = imageGenModeOf(settings.imageGen);
  if (mode === "off") {
    return failure(IMAGE_GEN_OFF_ERROR);
  }

  let source: { readonly absolute: string; readonly bytes: Uint8Array } | undefined;
  let revisionNote = "";
  if (clean.sourceImagePath !== undefined) {
    const resolved = await resolveCanvasImage(clean.projectRoot, clean.sourceImagePath);
    if (!resolved.ok) {
      return failure(resolved.error);
    }
    const revision = await describeCanvasRevision(clean.projectRoot, resolved.relative);
    revisionNote = formatRevision(revision);
    if (mode === "relay") {
      try {
        source = { absolute: resolved.absolute, bytes: await readFile(resolved.absolute) };
      } catch {
        return failure("找不到图片文件。");
      }
    } else {
      source = { absolute: resolved.absolute, bytes: new Uint8Array() };
    }
  }

  if (mode === "relay") {
    return runRelay(clean, source, revisionNote, deps);
  }
  return runCodex(clean, source?.absolute, revisionNote, deps);
}
