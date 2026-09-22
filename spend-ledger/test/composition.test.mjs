// 上下文成分测试。重点覆盖三个会静默失真的坑：
//   1) messages 是窗口（full/delta/tail），历史必须按残差算而不是按窗口占比放大
//   2) 密度只在 full 记录上标定
//   3) 没有 full 记录时必须降级并明确告警，而不是给一个看着很正常的错值
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeComposition, weightedLength, modelIoPath } from "../src/composition.mjs";

const SESSION = "sess_comp_1";

function makeHome(records) {
  const home = mkdtempSync(join(tmpdir(), "spend-comp-"));
  mkdirSync(join(home, "cli", "rollout"), { recursive: true });
  const file = join(home, "cli", "rollout", `model-io-${SESSION}.jsonl`);
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { home, file, env: { ...process.env, ZCODE_HOME: home } };
}

// 固定不变的 system 与 tools —— 与实机一致（82 条记录里完全一致）
const SYSTEM = [{ type: "text", text: "S".repeat(400), cache_control: { type: "ephemeral" } }];
const TOOLS = [
  { name: "Bash", description: "B".repeat(1200), input_schema: { type: "object" } },
  { name: "Read", description: "R".repeat(800), input_schema: { type: "object" } },
  { name: "mcp__srv__alpha", description: "A".repeat(2000), input_schema: { type: "object" } },
  { name: "mcp__srv__beta", description: "C".repeat(600), input_schema: { type: "object" } },
];

function rec({ kind, messages, inputTokens, at = 1000, requestId = "r" }) {
  return {
    requestId,
    turnId: "t1",
    startedAt: at,
    completedAt: at + 100,
    model: { modelId: "glm-test", providerId: "builtin:zai" },
    querySource: "main_turn",
    request: { messagesKind: kind, messageCount: 200, messageOffset: kind === "full" ? 0 : 190, messages, body: { system: SYSTEM, tools: TOOLS } },
    response: { usage: { inputTokens, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  };
}

test("静态开销逐条可算，且不随 messages 窗口变化", async () => {
  const { env } = makeHome([
    rec({ kind: "full", messages: [{ role: "user", content: "u".repeat(200) }], inputTokens: 1000, requestId: "r1" }),
    rec({ kind: "tail", messages: [{ role: "tool", content: "t".repeat(60) }], inputTokens: 4000, at: 2000, requestId: "r2" }),
  ]);
  const r = await analyzeComposition({ sessionId: SESSION, env });
  assert.equal(r.ok, true);
  assert.equal(r.requestCount, 2);

  const [a, b] = r.perRequest;
  // system 与 tools 完全相同 → 静态开销必须相同
  assert.equal(Math.round(a.staticTokens), Math.round(b.staticTokens), "静态开销不应随窗口变化");
  assert.ok(a.staticTokens > 0);

  // 历史按残差：实测 − 静态，因此窗口记录也能得到正确的历史量
  assert.equal(Math.round(a.historyTokens + a.staticTokens), 1000);
  assert.equal(Math.round(b.historyTokens + b.staticTokens), 4000);
  assert.ok(b.historyTokens > a.historyTokens, "请求更大时历史应更多");
});

test("MCP 工具按服务器拆分，且只统计 mcp__ 前缀", async () => {
  const { env } = makeHome([rec({ kind: "full", messages: [], inputTokens: 5000, requestId: "r1" })]);
  const r = await analyzeComposition({ sessionId: SESSION, env });
  const p = r.perRequest[0];
  assert.equal(p.mcpToolCount, 2);
  assert.equal(p.nativeToolCount, 2);
  assert.equal(p.mcpServers.length, 1);
  assert.equal(p.mcpServers[0].server, "srv");
  assert.equal(p.mcpServers[0].tools, 2);
  assert.ok(p.mcpServers[0].tokens > 0);
  // MCP 与原生之和应等于工具 schema 总量（允许浮点误差）
  assert.ok(Math.abs(p.mcpTokens + p.nativeToolTokens - p.toolsTokens) < 1e-6);
});

test("密度只由 full 记录标定，并回报样本数", async () => {
  const { env } = makeHome([
    rec({ kind: "full", messages: [{ role: "user", content: "u".repeat(200) }], inputTokens: 1000, requestId: "r1" }),
    rec({ kind: "delta", messages: [{ role: "user", content: "x".repeat(10) }], inputTokens: 2000, at: 2000, requestId: "r2" }),
    rec({ kind: "tail", messages: [{ role: "tool", content: "y".repeat(10) }], inputTokens: 3000, at: 3000, requestId: "r3" }),
  ]);
  const r = await analyzeComposition({ sessionId: SESSION, env });
  assert.equal(r.calibration.source, "full-records");
  assert.equal(r.calibration.samples, 1, "只有 full 记录参与标定");
  assert.ok(r.calibration.density > 0);

  // 用已知的 full 记录手算核对：密度 = 实测 / 加权长度
  const full = r.perRequest[0];
  const weightedContent =
    SYSTEM.reduce((a, s) => a + weightedLength(s.text).weighted, 0) +
    TOOLS.reduce((a, t) => a + weightedLength(JSON.stringify(t)).weighted, 0) +
    weightedLength("u".repeat(200)).weighted;
  assert.equal(Number(r.calibration.density.toFixed(10)), Number((1000 / weightedContent).toFixed(10)));
  assert.equal(Math.round(full.staticTokens), Math.round((weightedContent - weightedLength("u".repeat(200)).weighted) * r.calibration.density));
});

test("没有 full 记录时降级为默认密度并告警，而不是给出假精度", async () => {
  const { env } = makeHome([
    rec({ kind: "tail", messages: [], inputTokens: 1000, requestId: "r1" }),
    rec({ kind: "delta", messages: [], inputTokens: 2000, at: 2000, requestId: "r2" }),
  ]);
  const r = await analyzeComposition({ sessionId: SESSION, env });
  assert.equal(r.calibration.source, "default");
  assert.equal(r.calibration.samples, 0);
  assert.ok(r.calibration.caveat, "必须给出说明");
  assert.ok(r.warnings.includes("no-full-records-for-calibration"));
  assert.ok(r.assumptions.includes("density-fallback-used"));
});

test("窗口记录会触发 messages 窗口告警", async () => {
  const { env } = makeHome([rec({ kind: "tail", messages: [], inputTokens: 1000, requestId: "r1" })]);
  const r = await analyzeComposition({ sessionId: SESSION, env });
  assert.ok(r.warnings.includes("messages-windowed-history-is-residual"));
});

test("历史细分只在 full 记录上给出并标注样本数", async () => {
  const { env } = makeHome([
    rec({ kind: "full", messages: [{ role: "user", content: "u".repeat(100) }, { role: "assistant", content: "a".repeat(300) }], inputTokens: 2000, requestId: "r1" }),
    rec({ kind: "tail", messages: [{ role: "tool", content: "t".repeat(50) }], inputTokens: 4000, at: 2000, requestId: "r2" }),
  ]);
  const r = await analyzeComposition({ sessionId: SESSION, env });
  assert.equal(r.perRequest[0].historyBreakdown.user > 0, true);
  assert.equal(r.perRequest[1].historyBreakdown, null, "窗口记录不应给出历史细分");
  assert.equal(r.aggregate.historyBreakdown.samples, 1);
  assert.ok(r.aggregate.historyBreakdown.perRequest.assistant > r.aggregate.historyBreakdown.perRequest.user);
});

test("默认不输出提示原文（隐私）", async () => {
  const { env } = makeHome([rec({ kind: "full", messages: [{ role: "user", content: "SECRET_TOKEN_ABC" }], inputTokens: 1000, requestId: "r1" })]);
  const r = await analyzeComposition({ sessionId: SESSION, env });
  const json = JSON.stringify(r);
  assert.ok(!json.includes("SECRET_TOKEN_ABC"), "默认输出不得包含提示原文");
  assert.ok(r.assumptions.includes("text-omitted-for-privacy"));

  const withText = await analyzeComposition({ sessionId: SESSION, env, includeText: true });
  assert.ok(JSON.stringify(withText).includes("SSSS"), "显式开启后才附带片段");
  assert.ok(withText.assumptions.includes("text-included"));
});

test("maxRequests 只保留最近 N 条", async () => {
  const records = [];
  for (let i = 0; i < 10; i++) records.push(rec({ kind: "full", messages: [], inputTokens: 1000 + i, at: 1000 + i * 100, requestId: `r${i}` }));
  const { env } = makeHome(records);
  const r = await analyzeComposition({ sessionId: SESSION, env, maxRequests: 3 });
  assert.equal(r.requestCount, 3);
  assert.equal(r.perRequest[2].requestId, "r9");
});

test("文件不存在时给出可判别的错误码而不是抛异常", async () => {
  const env = { ...process.env, ZCODE_HOME: mkdtempSync(join(tmpdir(), "spend-comp-empty-")) };
  const r = await analyzeComposition({ sessionId: "sess_不存在", env });
  assert.equal(r.ok, false);
  assert.equal(r.error, "model-io-not-found");
});

test("modelIoPath 按会话 id 命名，与实机一致", () => {
  const p = modelIoPath("sess_x", { ZCODE_HOME: "C:/home" });
  assert.equal(p.replace(/\\/g, "/"), "C:/home/cli/rollout/model-io-sess_x.jsonl");
});
