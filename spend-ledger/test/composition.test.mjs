// 上下文静态构成测试。
//
// 这个模块的设计是「刻意不估 token」，所以测试重点有两类：
//   1) 精确字符量与密度无关占比算得对
//   2) 绝不出现任何绝对 token 估算（这是被实测推翻的方案，必须防止它悄悄回来）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeComposition, modelIoPath } from "../src/composition.mjs";

const SESSION = "sess_comp_1";

function makeHome(records) {
  const home = mkdtempSync(join(tmpdir(), "spend-comp-"));
  mkdirSync(join(home, "cli", "rollout"), { recursive: true });
  const file = join(home, "cli", "rollout", `model-io-${SESSION}.jsonl`);
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { home, file, env: { ...process.env, ZCODE_HOME: home } };
}

const SYSTEM_TEXT = "S".repeat(400);
const SYSTEM = [{ type: "text", text: SYSTEM_TEXT, cache_control: { type: "ephemeral" } }];
const TOOLS = [
  { name: "Bash", description: "B".repeat(1200), input_schema: { type: "object" } },
  { name: "Read", description: "R".repeat(800), input_schema: { type: "object" } },
  { name: "mcp__srv__alpha", description: "A".repeat(2000), input_schema: { type: "object" } },
  { name: "mcp__srv__beta", description: "C".repeat(600), input_schema: { type: "object" } },
];

// 期望值用与实现相同的方式算出，避免手写字符数写错——但算法本身是由测试独立复述的
const expectedSystemChars = SYSTEM_TEXT.length;
const expectedToolsChars = TOOLS.reduce((a, t) => a + JSON.stringify(t).length, 0);
const expectedNativeChars = TOOLS.filter((t) => !t.name.startsWith("mcp__")).reduce((a, t) => a + JSON.stringify(t).length, 0);
const expectedMcpChars = expectedToolsChars - expectedNativeChars;
const expectedSrvChars = TOOLS.filter((t) => t.name.startsWith("mcp__srv__")).reduce((a, t) => a + JSON.stringify(t).length, 0);

function rec({ kind = "full", messages = [], inputTokens = 1000, at = 1000, requestId = "r", tools = TOOLS, system = SYSTEM }) {
  return {
    requestId,
    turnId: "t1",
    startedAt: at,
    completedAt: at + 100,
    model: { modelId: "glm-test", providerId: "builtin:zai" },
    querySource: "main_turn",
    request: { messagesKind: kind, messageCount: 200, messageOffset: 0, messages, body: { system, tools } },
    response: { usage: { inputTokens, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  };
}

test("字符量精确：系统提示、工具 schema、原生与 MCP 各自算准", async () => {
  const { env } = makeHome([rec({ messages: [{ role: "user", content: "u".repeat(200) }], inputTokens: 1000 })]);
  const r = await analyzeComposition({ sessionId: SESSION, env });
  assert.equal(r.ok, true);
  const a = r.aggregate;
  assert.equal(a.systemChars, expectedSystemChars);
  assert.equal(a.toolsChars, expectedToolsChars);
  assert.equal(a.nativeChars, expectedNativeChars);
  assert.equal(a.mcpChars, expectedMcpChars);
  assert.equal(a.staticChars, expectedSystemChars + expectedToolsChars);
  assert.equal(a.nativeCount, 2);
  assert.equal(a.mcpCount, 2);
});

test("MCP 服务器按字符排序，占比在同一类内容内部计算", async () => {
  const { env } = makeHome([rec({})]);
  const r = await analyzeComposition({ sessionId: SESSION, env });
  const a = r.aggregate;
  assert.equal(a.serverCount, 1);
  assert.equal(a.servers.length, 1);
  const srv = a.servers[0];
  assert.equal(srv.server, "srv");
  assert.equal(srv.tools, 2);
  assert.equal(srv.chars, expectedSrvChars);
  // 占比 = 该服务器字符 / 工具 schema 总字符，与密度无关
  assert.equal(Number(srv.shareOfToolSchemas.toFixed(6)), Number((expectedSrvChars / expectedToolsChars).toFixed(6)));
  assert.equal(Number(srv.shareOfStatic.toFixed(6)), Number((expectedSrvChars / (expectedSystemChars + expectedToolsChars)).toFixed(6)));
  assert.equal(Number(a.mcpShareOfToolSchemas.toFixed(6)), Number((expectedMcpChars / expectedToolsChars).toFixed(6)));
});

test("绝不输出任何绝对 token 估算（该方案已被实测推翻）", async () => {
  const { env } = makeHome([rec({ messages: [{ role: "user", content: "u".repeat(200) }], inputTokens: 1000 })]);
  const r = await analyzeComposition({ sessionId: SESSION, env });
  const json = JSON.stringify(r);
  for (const forbidden of ["staticTokens", "historyTokens", "staticPerRequest", "toolsTokens", "mcpTokens", "density", "calibration"]) {
    assert.ok(!json.includes(forbidden), `输出不应包含 ${forbidden}`);
  }
  assert.equal(r.aggregate.staticTokens, undefined);
  assert.equal(r.calibration, undefined);
  // 但实测的 input_tokens 应当如实保留，供读者自行对照
  assert.equal(r.aggregate.avgObservedInputTokens, 1000);
  assert.equal(r.perRequest[0].observedInputTokens, 1000);
});

test("指明绝对构成以宿主面板为权威", async () => {
  const { env } = makeHome([rec({})]);
  const r = await analyzeComposition({ sessionId: SESSION, env });
  assert.equal(r.authority.absoluteTokens, "zcode-built-in-panel");
  assert.match(r.authority.note, /上下文容量/);
  assert.ok(r.assumptions.includes("chars-only-no-token-estimate"));
});

test("静态部分恒定时报稳定，工具集变化时报不稳定", async () => {
  const stable = await analyzeComposition({
    sessionId: SESSION,
    env: makeHome([rec({ at: 1000, requestId: "r1" }), rec({ at: 2000, requestId: "r2" })]).env,
  });
  assert.equal(stable.consistency.systemCharsStable, true);
  assert.equal(stable.consistency.toolsCharsStable, true);
  assert.ok(!stable.warnings.includes("tool-set-changed-mid-session"));

  const changed = await analyzeComposition({
    sessionId: SESSION,
    env: makeHome([
      rec({ at: 1000, requestId: "r1" }),
      rec({ at: 2000, requestId: "r2", tools: [...TOOLS, { name: "mcp__srv__gamma", description: "G".repeat(5000), input_schema: {} }] }),
    ]).env,
  });
  assert.equal(changed.consistency.toolsCharsStable, false);
  assert.ok(changed.warnings.includes("tool-set-changed-mid-session"));
  // 聚合值应取最后一条请求的状态
  assert.equal(changed.aggregate.serverCount, 1, "并集只统计出现过的服务器名");
  assert.ok(changed.aggregate.servers[0].chars > expectedSrvChars, "应反映最后一条请求的更大工具集");
});

test("窗口记录触发告警，说明为何不估算历史", async () => {
  const { env } = makeHome([rec({ kind: "tail", messages: [], inputTokens: 1000 })]);
  const r = await analyzeComposition({ sessionId: SESSION, env });
  assert.ok(r.warnings.includes("messages-windowed-no-history-estimate"));
});

test("默认不输出提示原文（隐私）", async () => {
  const { env } = makeHome([rec({ messages: [{ role: "user", content: "SECRET_TOKEN_ABC" }] })]);
  const r = await analyzeComposition({ sessionId: SESSION, env });
  const json = JSON.stringify(r);
  assert.ok(!json.includes("SECRET_TOKEN_ABC"), "默认输出不得包含提示原文");
  assert.ok(!json.includes("S".repeat(400)), "也不得包含系统提示原文");
  assert.ok(r.assumptions.includes("text-omitted-for-privacy"));
});

test("maxRequests 只保留最近 N 条", async () => {
  const records = [];
  for (let i = 0; i < 10; i++) records.push(rec({ at: 1000 + i * 100, inputTokens: 1000 + i, requestId: `r${i}` }));
  const { env } = makeHome(records);
  const r = await analyzeComposition({ sessionId: SESSION, env, maxRequests: 3 });
  assert.equal(r.requestCount, 3);
  assert.equal(r.perRequest[2].requestId, "r9");
});

test("文件不存在时给出可判别错误码而不是抛异常", async () => {
  const env = { ...process.env, ZCODE_HOME: mkdtempSync(join(tmpdir(), "spend-comp-empty-")) };
  const r = await analyzeComposition({ sessionId: "sess_不存在", env });
  assert.equal(r.ok, false);
  assert.equal(r.error, "model-io-not-found");
});

test("缺 sessionId 时报参数错误", async () => {
  const r = await analyzeComposition({});
  assert.equal(r.ok, false);
  assert.equal(r.error, "session-id-required");
});

test("modelIoPath 按会话 id 命名，与实机一致", () => {
  const p = modelIoPath("sess_x", { ZCODE_HOME: "C:/home" });
  assert.equal(p.replace(/\\/g, "/"), "C:/home/cli/rollout/model-io-sess_x.jsonl");
});
