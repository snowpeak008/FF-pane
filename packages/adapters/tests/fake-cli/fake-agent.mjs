/**
 * fake-cli：W2.1c 联调测试用的假 Agent CLI。
 * 用自己的迷你 JSONL 协议（非四家任何一家），目的只有一个：证明
 * process 层（W2.1a）→ 行解析（W2.1b）→ 适配器接口（W2.1c）整条管道可实现。
 *
 * 用法：node fake-agent.mjs [--mode=happy|garbage|hang|abrupt] [--exit-code=N]
 *   happy    正常全流程：session → say×2 → write_file → run_cmd → done，退出 0
 *   garbage  同 happy，但中间夹一条非 JSON 纯文本行（解析容错路径）
 *   hang     发出 session 后永不退出（取消路径）
 *   abrupt   发出 session 与一条 say 后直接以退出码 1 结束，无 done（崩溃兜底路径）
 */

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);
const mode = args.get("mode") ?? "happy";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const SESSION = { type: "session", session_id: "fake-session-001" };

if (mode === "hang") {
  emit(SESSION);
  // 永不退出；再拉起一个长睡眠孙进程，验证树杀连带清理
  setInterval(() => {}, 60_000);
} else if (mode === "abrupt") {
  emit(SESSION);
  emit({ type: "say", text: "开始执行……", final: false });
  process.exit(1);
} else {
  emit(SESSION);
  await sleep(10);
  emit({ type: "say", text: "你好，", final: false });
  if (mode === "garbage") {
    process.stdout.write("WARN: 这是一条裸文本诊断行，不是 JSON\n");
  }
  await sleep(10);
  emit({ type: "say", text: "任务完成。", final: true });
  emit({ type: "write_file", path: "hello.txt", kind: "add" });
  emit({ type: "run_cmd", command: "echo hi", exit_code: 0 });
  emit({ type: "unknown_extra", note: "归不进六类的原生事件" });
  emit({ type: "done", input_tokens: 12, output_tokens: 5 });
  process.exit(Number(args.get("exit-code") ?? "0"));
}
