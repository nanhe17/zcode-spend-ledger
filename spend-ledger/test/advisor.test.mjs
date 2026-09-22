// 建议引擎测试：每条规则都要能从构造的数据推出预期结论，
// 并确保「可省」不会被当成测量值、去重 id 稳定。
import { test } from "node:test";
import assert from "node:assert/strict";
import { advise } from "../src/advisor.mjs";

function baseReport(over = {}) {
  return {
    ok: true,
    scope: { kind: "session", sessionId: "s1" },
    totals: { input: 100_000, fresh: 20_000, cacheRead: 80_000, output: 5_000, cost: 1, cacheReadShare: 0.8 },
    dimensions: {
      querySource: [
        { key: "main_turn", requests: 5, input: 50_000, output: 3_000, cost: 0.5, shareInput: 0.5 },
        { key: "subagent", requests: 2, input: 49_700, output: 1_900, cost: 0.45, shareInput: 0.497 },
        { key: "session_title", requests: 3, input: 300, output: 100, cost: 0.01, shareInput: 0.003 },
      ],
      agent: [],
    },
    requests: [],
    toolsByBytes: [{ tool: "Bash", calls: 10, outputBytes: 900, durationMs: 1, errors: 0, readOnly: 0 }],
    attribution: { files: [], tools: [], growth: 0, attributed: 0, coverage: 0 },
    ...over,
  };
}

function comp(over = {}) {
  return {
    ok: true,
    sessionId: "sess_analyzed",
    aggregate: {
      requestCount: 10,
      avgInputTokens: 10_000,
      systemPerRequest: 2000,
      toolSchemaPerRequest: 5000,
      nativeToolPerRequest: 1000,
      mcpPerRequest: 4000,
      mcpServers: [{ server: "srv", tools: 3, perRequestTokens: 3000, totalTokens: 30_000, chars: 1000 }],
      staticPerRequest: 7000,
      staticShare: 0.7,
      ...over,
    },
  };
}

test("从未调用的 MCP 服务器：可省等于其全部固定开销", () => {
  const r = advise(baseReport(), comp());
  const f = r.findings.find((x) => x.rule === "mcp-schema-overhead");
  assert.ok(f, "应给出 MCP 固定开销建议");
  assert.equal(f.evidence.calledInAnalyzedRange, false);
  assert.equal(f.evidence.analyzedSession, "sess_analyzed", "证据里必须带上被分析的会话，便于核对范围");
  assert.equal(f.savingTokens, 30_000, "未被调用则可省全部固定开销");
  assert.match(f.recommendation, /从未被调用/);
});

test("被调用过的 MCP 服务器不夸大可省，但仍提示每轮固定成本", () => {
  const report = baseReport({ toolsByBytes: [{ tool: "mcp__srv__x", calls: 2, outputBytes: 10, durationMs: 1, errors: 0, readOnly: 1 }] });
  const r = advise(report, comp());
  const f = r.findings.find((x) => x.rule === "mcp-schema-overhead");
  assert.equal(f.evidence.calledInAnalyzedRange, true);
  assert.equal(f.savingTokens, 0, "被用过就不能把它的开销算成可省");
  assert.match(f.recommendation, /临时关闭/);
});

test("低于阈值的 MCP 服务器不产生噪音", () => {
  const r = advise(baseReport(), comp({ mcpServers: [{ server: "tiny", tools: 1, perRequestTokens: 100, totalTokens: 1000, chars: 10 }] }));
  assert.equal(r.findings.find((x) => x.rule === "mcp-schema-overhead"), undefined);
});

test("工具 schema 占总输入比例过高时给出提示", () => {
  const r = advise(baseReport(), comp());
  const f = r.findings.find((x) => x.rule === "tool-schema-total");
  assert.ok(f);
  assert.equal(f.evidence.mcp, 4000);
});

test("标题生成等辅助开销被单列", () => {
  const r = advise(baseReport(), comp());
  const f = r.findings.find((x) => x.rule === "aux-spend");
  assert.ok(f);
  assert.equal(f.savingTokens, 400);
});

test("重试与超上下文计入纯浪费", () => {
  const report = baseReport({
    requests: [
      { row: { context_exceeded: 1, retry_count: 0, cancelled_by_user: 0, input_tokens: 50_000, output_tokens: 100 }, price: { fresh: 0, costFresh: 0 } },
      { row: { context_exceeded: 0, retry_count: 2, cancelled_by_user: 0, input_tokens: 10_000, output_tokens: 50 }, price: { fresh: 0, costFresh: 0 } },
      { row: { context_exceeded: 0, retry_count: 0, cancelled_by_user: 1, input_tokens: 1000, output_tokens: 10 }, price: { fresh: 0, costFresh: 0 } },
    ],
  });
  const r = advise(report, comp());
  const f = r.findings.find((x) => x.rule === "retry-waste");
  assert.ok(f);
  assert.equal(f.evidence.requests, 3);
  assert.equal(f.evidence.contextExceeded, 1);
  assert.equal(f.evidence.retried, 1);
  assert.equal(f.savingTokens, 61_160);
});

test("重复读取同一文件时给出建议并扣除首次读取", () => {
  const report = baseReport({
    attribution: { files: [{ key: "a.ts", calls: 3, tokens: 900, cost: 0.01, share: 1 }], tools: [], growth: 0, attributed: 0, coverage: 0 },
  });
  const r = advise(report, comp());
  const f = r.findings.find((x) => x.rule === "repeated-reads");
  assert.ok(f);
  // 3 次读取中 2 次是可省的
  assert.equal(f.savingTokens, 600);
});

test("上下文膨胀按前后半段平均输入之比识别", () => {
  const requests = [];
  for (let i = 0; i < 10; i++) {
    requests.push({ row: { turn_id: `t${i}`, session_id: "s1", input_tokens: i < 5 ? 10_000 : 40_000, output_tokens: 100 }, price: { fresh: 0, costFresh: 1e-6 } });
  }
  const r = advise(baseReport({ requests }), comp());
  const f = r.findings.find((x) => x.rule === "context-bloat");
  assert.ok(f, "后半段 4 倍于前半段，应识别为膨胀");
  assert.equal(f.evidence.ratio, 4);
  assert.ok(f.savingTokens > 0);
});

test("轮次太少时不判断膨胀（避免噪声）", () => {
  const requests = [1, 2, 3].map((i) => ({ row: { turn_id: `t${i}`, session_id: "s", input_tokens: i * 100_000, output_tokens: 0 }, price: { fresh: 0, costFresh: 0 } }));
  const r = advise(baseReport({ requests }), comp());
  assert.equal(r.findings.find((x) => x.rule === "context-bloat"), undefined);
});

test("副代理占比显著时提示复核其性价比", () => {
  const r = advise(baseReport(), comp());
  const f = r.findings.find((x) => x.rule === "subagent-share");
  assert.ok(f);
  assert.ok(f.evidence.share > 0.2);
});

test("可省合计等于各条之和，严重度按金额门槛分级", () => {
  const r = advise(baseReport(), comp(), { inputRate: 1e-6 });
  assert.equal(r.estimatedSavingTokens, r.findings.reduce((a, f) => a + f.savingTokens, 0));

  // 门槛：≥$0.50 high，≥$0.05 medium，否则 low
  const small = advise(baseReport(), comp(), { inputRate: 1e-6 }).findings.find((x) => x.rule === "mcp-schema-overhead");
  assert.equal(small.severity, "low", "3 万 token × 1e-6 = $0.03 → low");

  const mid = advise(
    baseReport(),
    comp({ mcpServers: [{ server: "srv", tools: 3, perRequestTokens: 10_000, totalTokens: 100_000, chars: 1000 }] }),
    { inputRate: 1e-6 }
  ).findings.find((x) => x.rule === "mcp-schema-overhead");
  assert.equal(mid.severity, "medium", "10 万 token × 1e-6 = $0.10 → medium");

  const high = advise(
    baseReport(),
    comp({ mcpServers: [{ server: "srv", tools: 3, perRequestTokens: 100_000, totalTokens: 3_000_000, chars: 1000 }] }),
    { inputRate: 1e-6 }
  ).findings.find((x) => x.rule === "mcp-schema-overhead");
  assert.equal(high.severity, "high", "300 万 token × 1e-6 = $3 → high");
});

test("无法折算金额时按 token 量级分级，而不是全部退化为 low", () => {
  // baseReport 的 requests 为空 → 平均单价为 0，此时不能一律 low
  const r = advise(baseReport(), comp());
  const mcp = r.findings.find((x) => x.rule === "mcp-schema-overhead");
  assert.equal(mcp.severity, "low", "3 万 token 属于 low 量级");
  const big = advise(
    baseReport({ attribution: { files: [{ key: "a.ts", calls: 5, tokens: 2_000_000, cost: 0, share: 1 }], tools: [], growth: 0, attributed: 0, coverage: 0 } }),
    comp()
  );
  assert.equal(big.findings.find((x) => x.rule === "repeated-reads").severity, "high", "百万级 token 应判为 high");
});

test("finding id 稳定，便于账本去重", () => {
  const a = advise(baseReport(), comp()).findings.map((f) => f.id);
  const b = advise(baseReport(), comp()).findings.map((f) => f.id);
  assert.deepEqual(a, b);
});

test("报告不可用时安全返回，不抛异常", () => {
  const r = advise({ ok: false }, null);
  assert.equal(r.ok, false);
  assert.deepEqual(r.findings, []);
});

test("没有成分数据时仍能给出基于 DB 的建议", () => {
  const r = advise(baseReport(), null);
  assert.equal(r.ok, true);
  assert.ok(r.findings.some((f) => f.rule === "aux-spend"));
  assert.ok(!r.findings.some((f) => f.rule === "mcp-schema-overhead"));
});
