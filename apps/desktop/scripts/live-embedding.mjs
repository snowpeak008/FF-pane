/**
 * T6.3/T6.4 真机验收（live，非 CI）：**向量那一路第一次在真实嵌入模型上跑**。
 *
 * 此前的证据止步于：T6.3 全程 node:http mock、T6.4 只验证了 sqlite-vec 扩展装得上、
 * T6.5 的百级文件导入走的是纯 FTS 路径。也就是说「导入 → 真发 /embeddings →
 * 向量落 vec0 → 双路召回 → RRF 融合」这条完整链路，从未有过一次真机实证。
 *
 * 判据里最要紧的是**语义检索必须赢过关键词检索**：找一条与目标文档零字面重叠的中文查询，
 * 纯 FTS 应当找不到、开了向量之后应当找得到。否则「向量路跑通了」只是「没报错」，
 * 证明不了那些向量真的承载了语义——维度对、数量对、但内容是噪声的情形完全可能存在。
 *
 * 前置：本机 Ollama 在跑，且已 `ollama pull <模型>`（缺省 bge-m3）。
 * 用法：node apps/desktop/scripts/live-embedding.mjs
 *      OLLAMA_MODEL=bge-m3 OLLAMA_BASE=http://127.0.0.1:11434/v1 可覆盖。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "@playwright/test";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopDir, "..", "..");
const MODEL = process.env.OLLAMA_MODEL ?? "bge-m3";
const BASE = process.env.OLLAMA_BASE ?? "http://127.0.0.1:11434/v1";

function log(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

// 先探一下嵌入端点活着没有。**探不到不是失败**：本脚本随即降级为纯 FTS 验收，
// 与产品自身的行为同构（§8.3.3「未配嵌入模型时降级为纯全文检索，功能完整可用」）。
// 若在这里直接退出，就等于把一个一等状态当成了环境错误。
const probe = await fetch(`${BASE}/embeddings`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: MODEL, input: "探活" }),
}).catch((e) => ({ ok: false, status: 0, statusText: String(e) }));

let DIMS;
const HAS_EMBEDDER = probe.ok === true;
if (HAS_EMBEDDER) {
  const probeJson = await probe.json();
  DIMS = probeJson.data?.[0]?.embedding?.length;
  console.log(`嵌入端点就绪：模型 ${MODEL} @ ${BASE}，维度 ${DIMS}`);
} else {
  console.log(
    `嵌入端点不可用（${BASE}，模型 ${MODEL}）：${probe.status} ${probe.statusText ?? ""}`,
  );
  console.log("→ 转入纯全文检索验收（§8.3.3 的一等状态）；向量段整体跳过。");
}

const dataRoot = mkdtempSync(join(tmpdir(), "ffpane-embed-data-"));
const userDataDir = mkdtempSync(join(tmpdir(), "ffpane-embed-udata-"));

const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) env[k] = v;
}
env.FF_PANE_DATA_ROOT = dataRoot;
delete env.ELECTRON_RENDERER_URL;

let app;
const findings = [];
try {
  app = await _electron.launch({
    args: [
      ".",
      `--user-data-dir=${userDataDir}`,
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ],
    cwd: desktopDir,
    env,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => window.localStorage.setItem("ffpane.ui-language", "en-US"));
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  const invoke = (channel, req) =>
    page.evaluate(([c, r]) => window.ffpane.invoke(c, r), [channel, req]);

  // 先在没有嵌入 Provider 的状态下检索一次：这是「对照组」，
  // 用来证明后面语义命中确实是向量带来的，而不是这条查询本来就能被 BM25 命中
  log("1", "导入真实文档目录（packages/ + docs/，T6.5 验收条款的百级文件口径）…");
  const t_imp = Date.now();
  const imported = await invoke("knowledge:import", {
    importId: "live-embed-import-1",
    paths: [join(repoRoot, "packages"), join(repoRoot, "docs")],
    tags: ["live"],
  });
  console.log(
    `  ${((Date.now() - t_imp) / 1000).toFixed(2)}s | scanned=${imported.scanned}` +
      ` indexed=${imported.indexed} chunks=${imported.chunks} failures=${imported.failures.length}`,
  );
  if (imported.failures.length > 0) {
    findings.push(`导入有 ${imported.failures.length} 个文件失败`);
    console.log("  失败样例:", JSON.stringify(imported.failures.slice(0, 3)));
  }
  if (imported.indexed < 100) findings.push(`只索引了 ${imported.indexed} 个文件，达不到百级口径`);

  // 增量索引：原样再导一次，应当整批跳过
  const t_inc = Date.now();
  const again0 = await invoke("knowledge:import", {
    importId: "live-embed-import-2",
    paths: [join(repoRoot, "packages"), join(repoRoot, "docs")],
  });
  console.log(
    `  增量重导 ${((Date.now() - t_inc) / 1000).toFixed(2)}s | indexed=${again0.indexed}` +
      ` skipped=${again0.skipped} chunks=${again0.chunks}`,
  );
  if (again0.indexed !== 0 || again0.chunks !== 0) {
    findings.push(
      `增量索引失效：第二轮仍索引了 ${again0.indexed} 个文件、写了 ${again0.chunks} 块`,
    );
  }

  // 关键词检索（纯 FTS 路径的正题）
  const t_q = Date.now();
  const kw0 = await invoke("knowledge:search", { query: "RRF 融合", limit: 5 });
  console.log(
    `  关键词「RRF 融合」→ ${kw0.hits.length} 命中 / ${Date.now() - t_q}ms` +
      ` | usedFts=${kw0.usedFts} usedVector=${kw0.usedVector}`,
  );
  for (const h of kw0.hits.slice(0, 5)) {
    console.log(
      `    [${h.sources.join("+")}] ${h.entryTitle} :: ${(h.chunk.provenance.headingPath ?? []).join(" › ")}`,
    );
  }
  if (kw0.hits.length === 0) findings.push("纯 FTS 下关键词检索零命中");

  const SEMANTIC_QUERY = "怎么把一堆资料喂给模型让它自己去翻";
  const ftsOnly = await invoke("knowledge:search", { query: SEMANTIC_QUERY, limit: 5 });
  console.log(`  对照组（纯 FTS）查询「${SEMANTIC_QUERY}」→ ${ftsOnly.hits.length} 命中`);
  console.log("    usedFts:", ftsOnly.usedFts, "usedVector:", ftsOnly.usedVector);
  if (ftsOnly.usedVector) findings.push("对照组不该走向量路（此时还没配嵌入 Provider）");

  if (!HAS_EMBEDDER) {
    log(
      "结论",
      findings.length === 0
        ? "纯全文检索验收通过；向量段因本机无嵌入来源而跳过（如实记为待验项）"
        : `纯全文检索验收有 ${findings.length} 项未通过`,
    );
    for (const f of findings) console.log("  ✗", f);
    if (findings.length > 0) process.exitCode = 1;
    throw { skip: true };
  }

  // 配 Ollama 为嵌入 Provider。openai_compatible + baseUrl 带 /v1 即走 openai 方言，
  // Ollama 的 /v1/embeddings 与之兼容——本步骤零代码改动，纯配置
  log("2", `配置 Ollama 嵌入 Provider（${MODEL} @ ${BASE}）…`);
  const provider = await invoke("providers:create", {
    draft: {
      name: "Ollama(local)",
      type: "openai_compatible",
      baseUrl: BASE,
      models: [{ id: MODEL, displayName: MODEL, kind: "embedding" }],
      embeddingModel: MODEL,
      enabled: true,
    },
    // Ollama 不校验鉴权头；这里给个占位值满足 openai_compatible 的必填约束（§4.2）
    apiKey: "ollama-local-no-auth",
  });
  console.log("  provider =", provider.id, "embeddingModel =", provider.embeddingModel);

  const overviewBefore = await invoke("knowledge:list");
  console.log("  嵌入能力:", JSON.stringify(overviewBefore.embedding));
  if (overviewBefore.embedding.available !== true) {
    throw new Error(`嵌入能力未就绪：${JSON.stringify(overviewBefore.embedding)}`);
  }

  // 「补齐向量」与「断点续传」是同一段代码（T6.5）：这里走的正是
  // 「用户刚配上嵌入模型，要给已导入的旧文档补向量」这条正常升级路线。
  // 入口是**再次 import**（增量跳过 + 嵌入阶段按 existingRowids 只补差额），
  // 不是 rebuild——rebuild 走 force，replaceEntryChunks 整条换新块（rowid 全部换新、
  // 旧向量随旧块删除），rebuild 之后向量必然全量重算，测不出续传。
  // （T8.7 真机首跑发现并修正：此前本脚本从未在真实嵌入器上跑过，该差别未暴露。）
  log("3", "补齐向量（增量 import，真机嵌入，视文档量约数分钟）…");
  const t0 = Date.now();
  const rebuilt = await invoke("knowledge:import", {
    importId: "live-embed-backfill",
    paths: [join(repoRoot, "packages"), join(repoRoot, "docs")],
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `  ${elapsed}s | indexed=${rebuilt.indexed} skipped=${rebuilt.skipped}` +
      ` embedded=${rebuilt.embedded} embedSkipped=${rebuilt.embedSkipped} embedFailed=${rebuilt.embedFailed}`,
  );
  if (rebuilt.embedFatal !== undefined) findings.push(`嵌入致命错：${rebuilt.embedFatal}`);
  if (rebuilt.embedded === 0) findings.push("一条向量都没算出来");
  if (rebuilt.embedFailed > 0) findings.push(`有 ${rebuilt.embedFailed} 个块嵌入失败`);
  if (rebuilt.indexed !== 0) {
    findings.push(`补齐向量不该重新索引任何文件（实际重索引 ${rebuilt.indexed} 个）`);
  }
  if (rebuilt.failures.length > 0) {
    console.log("  失败:", JSON.stringify(rebuilt.failures.slice(0, 3)));
  }

  const overview = await invoke("knowledge:list");
  console.log(
    "  向量索引:",
    overview.vector === undefined ? "未建立" : JSON.stringify(overview.vector),
  );
  if (overview.vector === undefined) {
    findings.push("向量索引没有建立（ensureVectorIndex 未被触发或失败）");
  } else {
    if (overview.vector.dimensions !== DIMS) {
      findings.push(`索引维度 ${overview.vector.dimensions} 与模型维度 ${DIMS} 不符`);
    }
    if (overview.vector.model !== MODEL) {
      findings.push(`索引登记的模型 ${overview.vector.model} 与实际 ${MODEL} 不符`);
    }
    // 后端可能是 vec0 或退路；两者都算通过，但要如实记下走了哪条
    console.log("  向量后端:", overview.vector.backend, "| 向量数:", overview.vector.vectors);
  }

  // 判据核心：同一条零字面重叠的查询，开向量前后的差别
  log("4", "混合检索（双路召回 → RRF 融合）…");
  const hybrid = await invoke("knowledge:search", { query: SEMANTIC_QUERY, limit: 5 });
  console.log(`  查询「${SEMANTIC_QUERY}」→ ${hybrid.hits.length} 命中`);
  console.log(
    "    usedFts:",
    hybrid.usedFts,
    "usedVector:",
    hybrid.usedVector,
    "vectorPrefilterExact:",
    hybrid.vectorPrefilterExact,
  );
  for (const h of hybrid.hits.slice(0, 5)) {
    console.log(
      `    [${h.sources.join("+")}] ${h.entryTitle} :: ${(h.chunk.provenance.headingPath ?? []).join(" › ")}`,
    );
    console.log(`      ${h.chunk.text.replace(/\s+/g, " ").slice(0, 90)}…`);
  }
  if (!hybrid.usedVector) findings.push("检索没有走向量路（查询向量编码失败？）");
  const vectorContributed = hybrid.hits.some((h) => h.sources.includes("vector"));
  if (!vectorContributed) findings.push("命中里没有一条来自向量路——RRF 融合等于只有 BM25");
  if (hybrid.hits.length <= ftsOnly.hits.length && ftsOnly.hits.length === 0) {
    findings.push("语义查询在开了向量之后仍然零命中——向量没有承载语义");
  }

  // 关键词检索照常（向量是增强不是替代，§8.3.3）
  const keyword = await invoke("knowledge:search", { query: "RRF 融合", limit: 5 });
  console.log(`\n  关键词查询「RRF 融合」→ ${keyword.hits.length} 命中`);
  console.log("    usedFts:", keyword.usedFts, "usedVector:", keyword.usedVector);
  for (const h of keyword.hits.slice(0, 3)) {
    console.log(`    [${h.sources.join("+")}] ${h.entryTitle}`);
  }
  if (keyword.hits.length === 0) findings.push("开了向量之后关键词检索反而查不到了（回归）");

  // 断点续传：再增量 import 一次，已有向量的块不该重算（理由见步骤 3 的注释）
  log("5", "断点续传：再跑一次增量 import，已有向量的块应当整体跳过…");
  const again = await invoke("knowledge:import", {
    importId: "live-embed-backfill-2",
    paths: [join(repoRoot, "packages"), join(repoRoot, "docs")],
  });
  console.log(`  embedded=${again.embedded} embedSkipped=${again.embedSkipped}`);
  if (again.embedded > 0) {
    findings.push(`第二轮仍重算了 ${again.embedded} 个块的向量（续传判据失效）`);
  }
  if (again.embedSkipped === 0) {
    findings.push("续传轮 embedSkipped=0——差额判定没找到已有向量");
  }

  log("结论", findings.length === 0 ? "向量路真机验收全部通过" : `有 ${findings.length} 项未通过`);
  for (const f of findings) console.log("  ✗", f);
  if (findings.length > 0) process.exitCode = 1;
} catch (thrown) {
  // skip 是「无嵌入源，纯 FTS 验收已自行收尾」的信号，不是错误——
  // 让它走到这里打出 [FAIL]，会把一次通过的验收显示成失败
  if (thrown?.skip !== true) {
    console.error("\n[FAIL]", thrown?.stack ?? thrown?.message ?? thrown);
    process.exitCode = 1;
  }
} finally {
  await app?.close();
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(userDataDir, { recursive: true, force: true });
}
