// 建议引擎测试。重点守卫「折算口径」这件事：
// 实测本机数据里新增输入单价约 4.04e-7、缓存读取约 9.83e-9 美元/token，相差约 41 倍。
// 早先版本把常驻缓存的静态内容也按新增输入单价折算，于是把「省 $0.05」说成「省 $2.06」。
// 下面用实测数字做夹具，并把这条口径规则变成断言。
import { test } from "node:test";
import assert from "node:assert/strict";
import { advise } from "../src/advisor.mjs";

// 取自本机真实数据
const OBSERVED = {
  fresh: 1_365_077,
  costFresh: 0.5512,
  cacheRead: 56_657_856,
  costCacheRead: 0.5569,
  output: 521_593,
  costOutput: 0.6982,
};
const FRESH_RATE = OBSERVED.costFresh / OBSERVED.fresh; // ≈ 4.04e-7
const CACHE_RATE = OBSERVED.costCacheRead / OBSERVED.cacheRead; // ≈ 9.83e-9

function baseReport(over = {}) {
  return {
    ok: true,
    scope: { kind: "session", sessionId: "s1" },
    totals: {
      input: OBSERVED.fresh + OBSERVED.cacheRead,
      fresh: OBSERVED.fresh,
      cacheRead: OBSERVED.cacheRead,
      output: OBSERVED.output,
      cost: OBSERVED.costFresh + OBSERVED.costCacheRead + OBSERVED.costOutput,
      costFresh: OBSERVED.costFresh,
      costCacheRead: OBSERVED.costCacheRead,
      costOutput: OBSERVED.costOutput,
      cacheReadShare: OBSERVED.cacheRead / (OBSERVED.fresh + OBSERVED.cacheRead),
      unpricedRequests: 0,
    },
    dimensions: {
      querySource: [
        { key: "main_turn", requests: 5, input: 50_000, fresh: 10_000, output: 3_000, cost: 0.5, shareInput: 0.5 },
        { key: "subagent", requests: 2, input: 49_700, fresh: 9_000, output: 1_900, cost: 0.45, shareInput: 0.497 },
        { key: "session_title", requests: 3, input: 300, fresh: 250, output: 100, cost: 0.01, shareInput: 0.003 },
      ],
      agent: [],
    },
    requests: [],
    toolsByBytes: [{ tool: "Bash", calls: 10, outputBytes: 900, durationMs: 1, errors: 0, readOnly: 0 }],
    attribution: { files: [], tools: [], growth: 0, attributed: 0, coverage: 0 },
    ...over,
  };
}

function comp(over = {}, servers = [{ server: "srv", tools: 3, chars: 30_000, shareOfToolSchemas: 0.4, shareOfStatic: 0.2 }]) {
  return {
    ok: true,
    sessionId: "sess_analyzed",
    aggregate: { requestCount: 10, servers, avgObservedInputTokens: 10_000, toolsChars: 75_000, ...over },
  };
}

test("单价由实测数据推得，两者相差约 41 倍", () => {
  const r = advise(baseReport(), null);
  assert.equal(r.rates.source, "observed");
  assert.equal(Number(r.rates.fresh.toFixed(12)), Number(FRESH_RATE.toFixed(12)));
  assert.equal(Number(r.rates.cacheRead.toFixed(15)), Number(CACHE_RATE.toFixed(15)));
  const ratio = r.rates.fresh / r.rates.cacheRead;
  assert.ok(ratio > 35 && ratio < 50, `实测倍率应约为 41，实际 ${ratio.toFixed(1)}`);
});

test("常驻缓存的 MCP 工具定义只报字符与占比，绝不折算金额", () => {
  const r = advise(baseReport(), comp());
  const f = r.findings.find((x) => x.rule === "mcp-schema-overhead");
  assert.ok(f);
  assert.equal(f.savingKind, "chars-static");
  assert.equal(f.savingUsd, 0, "该项常驻缓存，折算美元会高估约 41 倍，因此必须为 0");
  assert.equal(f.savingTokens, 0, "不得给出 token 估算");
  assert.equal(f.savingChars, 30_000, "未被调用则可省其全部字符");
  assert.equal(f.share, 0.4);
  assert.match(f.basis, /不折算金额/);
  // 证据里不得出现绝对 token 数（那需要分词假设）
  assert.equal(f.evidence.tokens, undefined);
  assert.equal(f.evidence.perRequestTokens, undefined);
  assert.equal(f.evidence.chars, 30_000, "字符是精确值，应当给出");
});

test("被调用过的 MCP 服务器不夸大，但仍提示常驻占用", () => {
  const report = baseReport({ toolsByBytes: [{ tool: "mcp__srv__x", calls: 2, outputBytes: 10, durationMs: 1, errors: 0, readOnly: 1 }] });
  const r = advise(report, comp());
  const f = r.findings.find((x) => x.rule === "mcp-schema-overhead");
  assert.equal(f.evidence.calledInAnalyzedRange, true);
  assert.equal(f.savingChars, 0, "被用过就不能把它的常驻占用算成可省");
  assert.equal(f.savingUsd, 0);
  assert.match(f.recommendation, /临时关闭/);
});

test("字符量过小的 MCP 服务器不产生噪音", () => {
  const r = advise(baseReport(), comp({}, [{ server: "tiny", tools: 1, chars: 500, shareOfToolSchemas: 0.01, shareOfStatic: 0.005 }]));
  assert.equal(r.findings.find((x) => x.rule === "mcp-schema-overhead"), undefined);
});

test("常驻内容的严重度按占比分级，而不是按金额", () => {
  const low = advise(baseReport(), comp({}, [{ server: "a", tools: 1, chars: 9000, shareOfToolSchemas: 0.05, shareOfStatic: 0.02 }]))
    .findings.find((x) => x.rule === "mcp-schema-overhead");
  assert.equal(low.severity, "low", "占 5% 应为 low");
  const high = advise(baseReport(), comp({}, [{ server: "a", tools: 9, chars: 90_000, shareOfToolSchemas: 0.6, shareOfStatic: 0.3 }]))
    .findings.find((x) => x.rule === "mcp-schema-overhead");
  assert.equal(high.severity, "high", "占 60% 应为 high");
});

test("新增输入的省量按新增输入单价折算", () => {
  const report = baseReport({
    attribution: { files: [{ key: "a.ts", calls: 3, tokens: 900, cost: 0, share: 1 }], tools: [], growth: 0, attributed: 0, coverage: 0 },
  });
  const r = advise(report, null);
  const f = r.findings.find((x) => x.rule === "repeated-reads");
  assert.equal(f.savingKind, "tokens-fresh");
  assert.equal(f.savingTokens, 600, "3 次读取中 2 次可省");
  assert.equal(Number(f.savingUsd.toFixed(12)), Number((600 * FRESH_RATE).toFixed(12)));
  assert.ok(f.savingUsd > 600 * CACHE_RATE * 10, "应当明显高于按缓存口径的结果");
});

test("缓存内容的省量按缓存读取单价折算，而不是按新增输入", () => {
  const request = (over = {}) => ({ row: { turn_id: "t", session_id: "s1", input_tokens: 100_000, output_tokens: 0, ...over }, price: { fresh: 0, costFresh: 0 } });
  const report = baseReport({
    requests: [request({ retry_count: 2, context_exceeded: 0, cancelled_by_user: 0 })],
  });
  const r = advise(report, null);
  const f = r.findings.find((x) => x.rule === "retry-waste");
  assert.equal(f.savingKind, "tokens-cached");
  assert.equal(f.savingTokens, 100_000);
  assert.equal(Number(f.savingUsd.toFixed(15)), Number((100_000 * CACHE_RATE).toFixed(15)));
  const ifFreshRateHadBeenUsed = 100_000 * FRESH_RATE;
  assert.ok(f.savingUsd < ifFreshRateHadBeenUsed / 20, "若误用新增输入单价，金额会高估 41 倍——这条断言守住该错误");
});

test("上下文膨胀按单次请求的上下文规模判断，不把轮内请求数误当增长", () => {
  // 每轮一次请求：前半段上下文 1 万，后半段 4 万 → 规模确实增长 4 倍
  const requests = [];
  for (let i = 0; i < 10; i++) {
    requests.push({ row: { turn_id: `t${i}`, session_id: "s1", started_at: i * 1000, input_tokens: i < 5 ? 10_000 : 40_000, output_tokens: 100, retry_count: 0, context_exceeded: 0, cancelled_by_user: 0 }, price: { fresh: 0, costFresh: 0 } });
  }
  const r = advise(baseReport({ requests }), null);
  const f = r.findings.find((x) => x.rule === "context-bloat");
  assert.ok(f, "后半段 4 倍应被识别为膨胀");
  assert.equal(f.savingKind, "tokens-cached");
  assert.equal(f.evidence.ratio, 4);
  assert.equal(f.evidence.firstAvgContext, 10_000);
  assert.equal(f.evidence.secondAvgContext, 40_000);
  assert.equal(Number(f.savingUsd.toFixed(12)), Number((f.savingTokens * CACHE_RATE).toFixed(12)));
});

test("轮内请求变多不会被误判为上下文膨胀", () => {
  // 每轮上下文规模恒定 2 万，只是后半段每轮请求数变多。
  // 旧实现按轮求和，会算出 5 倍"增长"并报出超过模型上下文上限的数字。
  const requests = [];
  for (let i = 0; i < 10; i++) {
    const perTurn = i < 5 ? 1 : 5;
    for (let k = 0; k < perTurn; k++) {
      requests.push({
        row: { turn_id: `t${i}`, session_id: "s1", started_at: i * 1000 + k, input_tokens: 20_000, output_tokens: 50, retry_count: 0, context_exceeded: 0, cancelled_by_user: 0 },
        price: { fresh: 0, costFresh: 0 },
      });
    }
  }
  const r = advise(baseReport({ requests }), null);
  assert.equal(r.findings.find((x) => x.rule === "context-bloat"), undefined, "上下文规模没变就不应报膨胀");
});

test("轮次太少时不判断膨胀（避免噪声）", () => {
  const requests = [1, 2, 3].map((i) => ({ row: { turn_id: `t${i}`, session_id: "s", input_tokens: i * 100_000, output_tokens: 0 }, price: { fresh: 0, costFresh: 0 } }));
  const r = advise(baseReport({ requests }), null);
  assert.equal(r.findings.find((x) => x.rule === "context-bloat"), undefined);
});

test("纯信息性结论不给出可省金额", () => {
  const report = baseReport({
    // 副代理占比的分母是 totals.input，这里一并收小，才能测到 20% 以上
    totals: { ...baseReport().totals, input: 20_000 },
    toolsByBytes: [{ tool: "Bash", calls: 10, outputBytes: 9000, durationMs: 1, errors: 0, readOnly: 0 }],
    dimensions: {
      querySource: [
        { key: "main_turn", requests: 1, input: 10_000, fresh: 5_000, output: 1_000, cost: 0.1, shareInput: 0.5 },
        { key: "subagent", requests: 2, input: 10_000, fresh: 5_000, output: 1_000, cost: 0.1, shareInput: 0.5 },
      ],
      agent: [],
    },
  });
  const r = advise(report, null);
  for (const rule of ["tool-output-dominance", "subagent-share"]) {
    const f = r.findings.find((x) => x.rule === rule);
    assert.ok(f, `${rule} 应存在`);
    assert.equal(f.savingKind, "none");
    assert.equal(f.savingUsd, 0);
    assert.equal(f.savingTokens, 0);
    assert.ok(f.basis, "信息性结论也要说明为什么没有折算");
  }
});

test("汇总按口径分开统计，而不是混成一个数", () => {
  const report = baseReport({
    attribution: { files: [{ key: "a.ts", calls: 3, tokens: 900, cost: 0, share: 1 }], tools: [], growth: 0, attributed: 0, coverage: 0 },
    requests: [{ row: { turn_id: "t", session_id: "s1", input_tokens: 50_000, output_tokens: 0, retry_count: 1 }, price: { fresh: 0, costFresh: 0 } }],
  });
  const r = advise(report, comp());
  const s = r.estimatedSaving;
  // 新增输入口径 = 重复读取 600 + 辅助请求（fresh 250 + output 100 = 350）
  assert.equal(s.freshTokens, 950);
  assert.equal(s.cachedTokens, 50_000, "重试属于缓存口径");
  assert.equal(s.staticChars, 30_000, "常驻字符单独统计");
  assert.equal(
    Number(s.usd.toFixed(12)),
    Number((950 * FRESH_RATE + 50_000 * CACHE_RATE).toFixed(12)),
    "两种口径各按自己的单价折算后相加"
  );
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
  assert.equal(r.estimatedSaving.usd, 0);
});

test("没有成分数据时仍能给出基于 DB 的建议", () => {
  const r = advise(baseReport(), null);
  assert.equal(r.ok, true);
  assert.ok(r.findings.some((f) => f.rule === "aux-spend"));
  assert.ok(!r.findings.some((f) => f.rule === "mcp-schema-overhead"));
});

test("每条结论都必须带折算口径说明", () => {
  const report = baseReport({
    toolsByBytes: [{ tool: "Bash", calls: 10, outputBytes: 9000, durationMs: 1, errors: 0, readOnly: 0 }],
    attribution: { files: [{ key: "a.ts", calls: 2, tokens: 500, cost: 0, share: 1 }], tools: [], growth: 0, attributed: 0, coverage: 0 },
    requests: [{ row: { turn_id: "t", session_id: "s1", input_tokens: 50_000, output_tokens: 0, retry_count: 1 }, price: { fresh: 0, costFresh: 0 } }],
  });
  const r = advise(report, comp());
  assert.ok(r.findings.length >= 4);
  for (const f of r.findings) {
    assert.ok(f.basis && f.basis.length > 5, `${f.rule} 缺少折算口径说明`);
    assert.ok(["tokens-fresh", "tokens-cached", "chars-static", "none"].includes(f.savingKind), `${f.rule} 的 savingKind 非法`);
  }
});
