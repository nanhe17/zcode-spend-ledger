// 定价层测试。重点是把两个业界已踩过的坑固化为回归测试：
//   1) input_tokens 含缓存量（ccusage Issue #888/#899 类问题）
//   2) 上游全零价占位条目导致的静默 $0
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPricer, loadSnapshot, loadOverrides, normalizeModelKey } from "../src/pricing.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "spend-pricing-"));
const snapshotPath = join(tmp, "snap.json");
writeFileSync(
  snapshotPath,
  JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    models: {
      "glm-test": { input: 1e-6, output: 2e-6, cacheRead: 1e-7, cacheWrite: 5e-7, source: "test" },
      "no-cache-write": { input: 1e-6, output: 2e-6, cacheRead: null, cacheWrite: null, source: "test" },
      "zero-price": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, source: "test" },
      "tiered": {
        input: 1e-6,
        output: 2e-6,
        cacheRead: 1e-7,
        cacheWrite: null,
        tiers: [{ over: 200000, input: 2e-6, output: 4e-6, cacheRead: 2e-7 }],
        source: "test",
      },
      "zai/glm-prefixed": { input: 3e-6, output: 6e-6, cacheRead: 3e-7, cacheWrite: null, source: "test" },
    },
  })
);
const snapshot = loadSnapshot(snapshotPath);

function pricerWith(overrides = { models: {} }, opts = {}) {
  return createPricer({ snapshot, overrides, ...opts });
}

test("input_tokens 含缓存量时，新增输入必须扣除缓存读取与缓存写入", () => {
  const p = pricerWith();
  const out = p.priceRow(
    { model_id: "glm-test", input_tokens: 1_000_000, cache_read_input_tokens: 900_000, cache_creation_input_tokens: 50_000, output_tokens: 10_000 },
    "zai"
  );
  assert.equal(out.fresh, 50_000, "fresh = 1,000,000 − 900,000 − 50,000");
  assert.equal(out.cacheRead, 900_000);
  assert.equal(out.cacheWrite, 50_000);

  // 100 万 input 直接按输入价计价会得到 $1；正确结果应远小于它
  const naive = 1_000_000 * 1e-6;
  assert.ok(out.total < naive / 5, `正确费用 ${out.total} 应远低于按原价高估的 ${naive}`);

  const expected = 50_000 * 1e-6 + 900_000 * 1e-7 + 50_000 * 5e-7 + 10_000 * 2e-6;
  assert.equal(Number(out.total.toFixed(12)), Number(expected.toFixed(12)));
});

test("缓存读取占满输入时，新增输入为 0 且不产生负值", () => {
  const p = pricerWith();
  const out = p.priceRow({ model_id: "glm-test", input_tokens: 49295, cache_read_input_tokens: 49280, output_tokens: 1642 }, null);
  assert.equal(out.fresh, 15);
  assert.equal(p.stats.negativeFreshRows, 0);
});

test("input_tokens 小于缓存量时钳位到 0 并计数（上游语义漂移的哨兵）", () => {
  const p = pricerWith();
  const out = p.priceRow({ model_id: "glm-test", input_tokens: 100, cache_read_input_tokens: 500, output_tokens: 10 }, null);
  assert.equal(out.fresh, 0);
  assert.equal(p.stats.negativeFreshRows, 1, "必须记录异常行数，供报告与 doctor 暴露");
});

test("全零价条目视为未定价，而不是静默按 $0 计价", () => {
  const p = pricerWith();
  const out = p.priceRow({ model_id: "zero-price", input_tokens: 1_000_000, output_tokens: 500_000 }, null);
  assert.equal(out.priced, false);
  assert.equal(out.reason, "unpriced-model");
  assert.equal(out.total, 0);
  assert.deepEqual(p.unpricedModels(), ["zero-price"]);
});

test("未知模型标记为未定价", () => {
  const p = pricerWith();
  const out = p.priceRow({ model_id: "完全不存在的模型", input_tokens: 100, output_tokens: 100 }, null);
  assert.equal(out.priced, false);
});

test("缓存写入单价缺失时使用回退倍率，并记录假设", () => {
  const p = pricerWith({ models: {} }, { cacheWriteMultiplier: 1.25 });
  const out = p.priceRow({ model_id: "no-cache-write", input_tokens: 1000, cache_creation_input_tokens: 400, output_tokens: 100 }, null);
  assert.ok(out.assumptions.includes("cache-write-multiplier"));
  assert.equal(Number(out.costCacheWrite.toFixed(12)), Number((400 * 1e-6 * 1.25).toFixed(12)));
  assert.equal(p.stats.assumedCacheWriteTokens, 400);
});

test("上游明确标 0 的缓存写入不套用回退倍率", () => {
  const p = pricerWith();
  const out = p.priceRow({ model_id: "glm-test", input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 100 }, null);
  assert.equal(out.costCacheWrite, 200 * 5e-7);
  assert.ok(!out.assumptions.includes("cache-write-multiplier"));
});

test("超过分段阈值后使用更高档位", () => {
  const p = pricerWith();
  const below = p.priceRow({ model_id: "tiered", input_tokens: 100_000, output_tokens: 1000 }, null);
  const above = p.priceRow({ model_id: "tiered", input_tokens: 300_000, output_tokens: 1000 }, null);
  assert.equal(below.costOutput, 1000 * 2e-6);
  assert.equal(above.costOutput, 1000 * 4e-6, "超过 200k 后应使用 4e-6");
});

test("用户覆盖优先于内置快照", () => {
  const overrides = loadOverrides(
    (() => {
      const p = join(tmp, "override.json");
      writeFileSync(p, JSON.stringify({ models: { "glm-test": { input: 9e-6, output: 9e-6, cacheRead: 9e-7, cacheWrite: 9e-7 } } }));
      return p;
    })()
  );
  const p = createPricer({ snapshot, overrides });
  const out = p.priceRow({ model_id: "glm-test", input_tokens: 1000, output_tokens: 100 }, null);
  assert.equal(out.costFresh, 1000 * 9e-6);
  assert.equal(out.rateSource, "user-override");
});

test("厂商前缀作为候选参与匹配", () => {
  const p = pricerWith();
  const hit = p.rateFor("glm-prefixed", "zai");
  assert.ok(hit, "应通过 zai/ 前缀命中");
  assert.equal(hit.matchedKey, "zai/glm-prefixed");
});

test("模型名大小写与连字符变体可归一", () => {
  const p = pricerWith();
  assert.ok(p.rateFor("GLM-Test", null), "大小写不应影响匹配");
  assert.equal(normalizeModelKey("  GLM-Test "), "glm-test");
});

test("快照缺失时不抛异常，而是全部标记未定价", () => {
  const p = createPricer({ snapshot: loadSnapshot(join(tmp, "does-not-exist.json")) });
  const out = p.priceRow({ model_id: "glm-test", input_tokens: 100, output_tokens: 100 }, null);
  assert.equal(out.priced, false);
});
