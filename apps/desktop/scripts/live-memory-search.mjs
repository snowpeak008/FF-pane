/**
 * T8.7 真机验收（live，非 CI）：记忆语义检索端到端——真实 Electron 主进程 +
 * 真实 Ollama 嵌入模型（缺省 bge-m3），走 preload → memory:* 通道全链路。
 *
 * 判据核心与 live-embedding 同一条：**语义检索必须赢过关键词检索**。
 * 造几条与查询零字面重合的记忆条目（如「执行 vitest 命令」条目 vs 查询「怎么跑单测」），
 * 纯 FTS 下应当零命中、配上嵌入来源后应当命中——否则「向量路跑通了」只是「没报错」。
 *
 * 另验：批量回填（存量条目首查即补向量）、断点续传（第二查零新嵌入——由耗时侧写）、
 * 编辑后重嵌入（memory:update 钩子）、删除出索引（memory:reject 钩子）、过滤下推。
 *
 * 前置：本机 Ollama 在跑，且已 `ollama pull <模型>`（缺省 bge-m3）。
 * 用法：node apps/desktop/scripts/live-memory-search.mjs
 *      OLLAMA_MODEL=bge-m3 OLLAMA_BASE=http://127.0.0.1:11434/v1 可覆盖。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "@playwright/test";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = process.env.OLLAMA_MODEL ?? "bge-m3";
const BASE = process.env.OLLAMA_BASE ?? "http://127.0.0.1:11434/v1";

function log(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

// 探活。探不到不是失败：降级为纯 FTS 验收（与产品行为同构，§8.3.3）。
const probe = await fetch(`${BASE}/embeddings`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: MODEL, input: "探活" }),
}).catch((e) => ({ ok: false, status: 0, statusText: String(e) }));

const HAS_EMBEDDER = probe.ok === true;
if (HAS_EMBEDDER) {
  const probeJson = await probe.json();
  console.log(
    `嵌入端点就绪：模型 ${MODEL} @ ${BASE}，维度 ${probeJson.data?.[0]?.embedding?.length}`,
  );
} else {
  console.log(`嵌入端点不可用（${BASE}）：${probe.status} ${probe.statusText ?? ""}`);
  console.log("→ 转入纯关键词检索验收；语义段整体跳过。");
}

const dataRoot = mkdtempSync(join(tmpdir(), "ffpane-memsearch-data-"));
const userDataDir = mkdtempSync(join(tmpdir(), "ffpane-memsearch-udata-"));
const projectRoot = mkdtempSync(join(tmpdir(), "ffpane-memsearch-proj-"));

const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) env[k] = v;
}
env.FF_PANE_DATA_ROOT = dataRoot;
delete env.ELECTRON_RENDERER_URL;

/** 语料：三条记忆，标题正文与下方语义查询零字面重合（这是判据成立的前提）。 */
const ENTRIES = [
  {
    id: "mem-live-test",
    category: "lesson",
    title: "执行 vitest 命令",
    body: "本仓一律 pnpm exec vitest run，别用 npm",
    status: "active",
    source: { kind: "user_manual" },
    confidence: "high",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: "mem-live-deploy",
    category: "rule",
    title: "部署流程",
    body: "上线前逐项核对发布清单，晚高峰禁止发布",
    status: "active",
    source: { kind: "user_manual" },
    confidence: "high",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: "mem-live-proxy",
    category: "decision",
    title: "网络出口走公司代理",
    body: "外网请求统一经 proxy.internal:8080 转发",
    status: "active",
    source: { kind: "user_manual" },
    confidence: "high",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

/** 语义查询：与 mem-live-test 的标题正文无一字面重合词（trigram ≥3 码点意义上）。 */
const SEMANTIC_QUERY = "怎么跑单测";

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

  const invoke = (channel, req) =>
    page.evaluate(([c, r]) => window.ffpane.invoke(c, r), [channel, req]);

  log("1", "登记项目并写入三条记忆（memory:update 走真实 saveEntry + 索引钩子）…");
  await invoke("projects:create", { name: "记忆语义检索验收", rootPath: projectRoot });
  for (const entry of ENTRIES) {
    await invoke("memory:update", { projectRoot, entry });
  }
  const listed = await invoke("memory:list", { projectRoot });
  console.log(`  memory:list → ${listed.length} 条`);
  if (listed.length !== ENTRIES.length) {
    findings.push(`写入 ${ENTRIES.length} 条只读回 ${listed.length} 条`);
  }

  if (!HAS_EMBEDDER) {
    // 纯关键词验收：关键词可查、语义查询如实零命中、blocker 如实
    const kw = await invoke("memory:search", { projectRoot, query: "vitest" });
    console.log(
      `  关键词「vitest」→ ${kw.hits.length} 命中 | usedVector=${kw.usedVector}` +
        ` blocker=${kw.embeddingBlocker ?? "-"}`,
    );
    if (kw.hits[0]?.id !== "mem-live-test") findings.push("纯 FTS 关键词检索没查到目标条目");
    if (kw.embeddingBlocker !== "no-provider") findings.push("降级原因码不是 no-provider");
    const sem = await invoke("memory:search", { projectRoot, query: SEMANTIC_QUERY });
    if (sem.hits.length > 0) findings.push("纯 FTS 下语义查询不该命中（对照组失真）");
    log(
      "结论",
      findings.length === 0
        ? "纯关键词检索验收通过；语义段因本机无嵌入来源而跳过（如实记为待验项）"
        : `有 ${findings.length} 项未通过`,
    );
    for (const f of findings) console.log("  ✗", f);
    if (findings.length > 0) process.exitCode = 1;
    throw { skip: true };
  }

  // 对照组必须在配 Provider **之前**取——证明后面的语义命中确实是向量带来的
  log("2", `对照组（未配嵌入来源）查询「${SEMANTIC_QUERY}」…`);
  const control = await invoke("memory:search", { projectRoot, query: SEMANTIC_QUERY });
  console.log(
    `  → ${control.hits.length} 命中 | usedFts=${control.usedFts}` +
      ` usedVector=${control.usedVector} blocker=${control.embeddingBlocker ?? "-"}`,
  );
  if (control.usedVector) findings.push("对照组不该走向量路（此时还没配嵌入 Provider）");
  if (control.hits.length > 0) findings.push("对照组语义查询命中非零，判据失去对照意义");

  log("3", `配置 Ollama 嵌入 Provider（${MODEL} @ ${BASE}）…`);
  await invoke("providers:create", {
    draft: {
      name: "Ollama(local)",
      type: "openai_compatible",
      baseUrl: BASE,
      models: [{ id: MODEL, displayName: MODEL, kind: "embedding" }],
      embeddingModel: MODEL,
      enabled: true,
    },
    apiKey: "ollama-local-no-auth",
  });

  log("4", "混合检索（首查触发存量批量回填 + 查询嵌入 → RRF 融合）…");
  const t0 = Date.now();
  const hybrid = await invoke("memory:search", { projectRoot, query: SEMANTIC_QUERY });
  const firstMs = Date.now() - t0;
  console.log(
    `  「${SEMANTIC_QUERY}」→ ${hybrid.hits.length} 命中 / ${firstMs}ms` +
      ` | usedFts=${hybrid.usedFts} usedVector=${hybrid.usedVector}`,
  );
  for (const hit of hybrid.hits) {
    console.log(`    [${hit.sources.join("+")}] ${hit.id} :: ${hit.title}`);
  }
  if (!hybrid.usedVector) findings.push("检索没有走向量路");
  if (hybrid.hits[0]?.id !== "mem-live-test") {
    findings.push(
      `语义查询第一名应为 mem-live-test（执行 vitest 命令），实际 ${hybrid.hits[0]?.id ?? "无命中"}`,
    );
  }
  if (!(hybrid.hits[0]?.sources ?? []).includes("vector")) {
    findings.push("目标条目的命中来源不含 vector——说明是关键词碰上的，不是语义");
  }

  // 第二条语义查询再证一次（部署语义组）
  const deployQuery = "发版要注意什么";
  const deployHit = await invoke("memory:search", { projectRoot, query: deployQuery });
  console.log(`  「${deployQuery}」→ 第一名 ${deployHit.hits[0]?.id ?? "无"}`);
  if (deployHit.hits[0]?.id !== "mem-live-deploy") {
    findings.push(`「${deployQuery}」第一名应为 mem-live-deploy，实际 ${deployHit.hits[0]?.id}`);
  }

  log("5", "断点续传：第二查不再重嵌条目（耗时应显著低于首查）…");
  const t1 = Date.now();
  await invoke("memory:search", { projectRoot, query: "上线流程怎么走" });
  const secondMs = Date.now() - t1;
  console.log(`  第二查 ${secondMs}ms（首查 ${firstMs}ms，首查含 ${ENTRIES.length} 条回填）`);
  // 不拿绝对阈值卡（机器负载不可控），只登记数字；正确性由单测的请求计数断言钉死

  log("6", "编辑后重嵌入：改写 mem-live-proxy 的语义，再用新语义查询…");
  const edited = {
    ...ENTRIES[2],
    title: "数据库备份策略",
    body: "每天凌晨全量备份一次，保留 30 天",
    updatedAt: Date.now(),
  };
  await invoke("memory:update", { projectRoot, entry: edited });
  const backup = await invoke("memory:search", { projectRoot, query: "定期存档数据怎么安排" });
  console.log(`  「定期存档数据怎么安排」→ 第一名 ${backup.hits[0]?.id ?? "无"}`);
  if (backup.hits[0]?.id !== "mem-live-proxy") {
    findings.push(`编辑后新语义应命中 mem-live-proxy，实际 ${backup.hits[0]?.id}`);
  }

  log("7", "关键词检索照常（向量是增强不是替代）+ 过滤下推…");
  const keyword = await invoke("memory:search", { projectRoot, query: "vitest" });
  if (keyword.hits[0]?.id !== "mem-live-test") findings.push("关键词检索回归：vitest 查不到目标");
  const filtered = await invoke("memory:search", {
    projectRoot,
    query: SEMANTIC_QUERY,
    categories: ["rule"],
  });
  if (filtered.hits.some((hit) => hit.id === "mem-live-test")) {
    findings.push("category 过滤失效：lesson 条目出现在 rule 过滤的结果里");
  }

  log("8", "删除出索引：memory:reject 后语义查询不再命中该条…");
  await invoke("memory:reject", { projectRoot, id: "mem-live-test" });
  const afterDelete = await invoke("memory:search", { projectRoot, query: SEMANTIC_QUERY });
  if (afterDelete.hits.some((hit) => hit.id === "mem-live-test")) {
    findings.push("删除后的条目仍被语义召回（向量没删干净）");
  }

  log(
    "结论",
    findings.length === 0 ? "记忆语义检索真机验收全部通过" : `有 ${findings.length} 项未通过`,
  );
  for (const f of findings) console.log("  ✗", f);
  if (findings.length > 0) process.exitCode = 1;
} catch (thrown) {
  if (thrown?.skip !== true) {
    console.error("\n[FAIL]", thrown?.stack ?? thrown?.message ?? thrown);
    process.exitCode = 1;
  }
} finally {
  await app?.close();
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
}
