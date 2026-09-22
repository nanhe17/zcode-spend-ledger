// 定价层：把 model_usage 的原始 token 列换算成美元。
//
// 两条必须遵守的规则（都来自实测，不是推测）：
//
// 1) input_tokens 已经包含缓存读取与缓存写入。
//    实测本机 542 条已完成请求：sum(input)=48,773,725，sum(cache_read)=45,545,984，
//    即 93.4% 的输入是缓存读取；最坏一行 100% 是缓存读取。
//    若把 input_tokens 直接按输入单价计价，会高估约 15 倍（1/(1-0.934)）。
//    因此新增输入fresh = input − cache_read − cache_creation，且必须钳到非负。
//
// 2) 上游存在「全零价」占位条目（input=0 且 output=0），
//    直接采用会让报告显示 $0 却看不出原因。构建快照时已剔除，运行时再次防御。
//
// 定价解析顺序：用户覆盖 → 内置快照 → 未定价（显式标记，绝不静默记 0）。
import { readFileSync, existsSync } from "node:fs";

export const CACHE_WRITE_MULTIPLIER_DEFAULT = 1.25; // 5 分钟缓存写入的业界标准倍率

const STALE_DAYS_WARN = 90;

export function loadSnapshot(path) {
  if (!path || !existsSync(path)) return { version: 0, models: {}, rejected: [], missing: true };
  try {
    const s = JSON.parse(readFileSync(path, "utf8"));
    return { ...s, missing: false };
  } catch (err) {
    return { version: 0, models: {}, rejected: [], missing: true, error: String(err.message) };
  }
}

export function loadOverrides(path) {
  if (!path || !existsSync(path)) return { models: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    // 支持两种写法：{models:{...}} 或直接 {模型名: {...}}
    const models = raw.models ?? raw;
    const out = {};
    for (const [k, v] of Object.entries(models)) {
      if (!v || typeof v !== "object") continue;
      out[normalizeModelKey(k)] = v;
    }
    return { models: out, path };
  } catch (err) {
    return { models: {}, path, error: String(err.message) };
  }
}

export function normalizeModelKey(name) {
  return String(name ?? "").toLowerCase().trim();
}

// 快照与覆盖里都可能带厂商前缀，逐级降级匹配
export function resolveRate(model, providerName, sources) {
  const key = normalizeModelKey(model);
  const candidates = [];
  if (providerName) candidates.push(`${normalizeModelKey(providerName)}/${key}`);
  candidates.push(key);
  // 去掉日期/版本后缀再试一次，例如 claude-3-5-sonnet-20241022 → claude-3-5-sonnet
  candidates.push(key.replace(/[-@](\d{4,8}|\d{4}-\d{2}-\d{2})$/, ""));
  candidates.push(key.replace(/-(latest|preview|exp)$/, ""));

  for (const src of sources) {
    for (const c of candidates) {
      const hit = src.models?.[c];
      if (hit) return { rate: hit, matchedKey: c, source: src.name ?? src.source ?? "unknown" };
    }
  }
  return null;
}

/**
 * 创建定价器。
 * @param {object} opts
 * @param {object} opts.snapshot  loadSnapshot() 的返回值
 * @param {object} opts.overrides loadOverrides() 的返回值
 * @param {number} opts.cacheWriteMultiplier 缓存写入单价缺失时的回退倍率
 */
export function createPricer({ snapshot, overrides = { models: {} }, cacheWriteMultiplier = CACHE_WRITE_MULTIPLIER_DEFAULT } = {}) {
  const sources = [
    { name: "user-override", models: overrides.models },
    { name: `snapshot:${snapshot?.version ?? 0}`, models: snapshot?.models ?? {} },
  ];
  const cache = new Map();
  const unpriced = new Set();
  const stats = {
    assumedCacheWriteTokens: 0,
    assumedCacheWriteModels: new Set(),
    negativeFreshRows: 0,
    cacheReadShareNumerator: 0,
    inputTotal: 0,
  };

  function rateFor(model, providerName) {
    const ck = `${providerName ?? ""}|${normalizeModelKey(model)}`;
    if (cache.has(ck)) return cache.get(ck);
    let resolved = resolveRate(model, providerName, sources);
    if (resolved) {
      const r = resolved.rate;
      // 防御全零价条目
      if ((r.input ?? 0) === 0 && (r.output ?? 0) === 0) resolved = null;
    }
    cache.set(ck, resolved);
    if (!resolved) unpriced.add(model);
    return resolved;
  }

  /**
   * 给一条 model_usage 行定价。
   * @returns {{priced:boolean, reason?:string, fresh:number, cacheRead:number, cacheWrite:number, output:number,
   *            costFresh:number, costCacheRead:number, costCacheWrite:number, costOutput:number, total:number,
   *            rateSource?:string, matchedKey?:string, assumptions:string[]}}
   */
  function priceRow(row, providerName) {
    const input = num(row.input_tokens);
    const cacheRead = num(row.cache_read_input_tokens);
    const cacheWrite = num(row.cache_creation_input_tokens);
    const output = num(row.output_tokens);

    let fresh = input - cacheRead - cacheWrite;
    if (fresh < 0) {
      // input_tokens 语义若在上游发生变化，这里会立刻暴露，而不是悄悄算错
      stats.negativeFreshRows++;
      fresh = 0;
    }
    stats.inputTotal += input;
    stats.cacheReadShareNumerator += cacheRead;

    const base = {
      fresh,
      cacheRead,
      cacheWrite,
      output,
      costFresh: 0,
      costCacheRead: 0,
      costCacheWrite: 0,
      costOutput: 0,
      total: 0,
      assumptions: [],
    };

    const resolved = rateFor(row.model_id, providerName);
    if (!resolved) {
      return { ...base, priced: false, reason: "unpriced-model" };
    }

    const rate = applyTier(resolved.rate, input);
    const assumptions = [];
    let cacheWriteRate = rate.cacheWrite;
    if (cacheWrite > 0) {
      if (cacheWriteRate == null) {
        cacheWriteRate = rate.input * cacheWriteMultiplier;
        assumptions.push("cache-write-multiplier");
        stats.assumedCacheWriteTokens += cacheWrite;
        stats.assumedCacheWriteModels.add(row.model_id);
      } else if (cacheWriteRate === 0) {
        // 上游明确标 0：按 0 计，但记录下来，避免被误读为"免费"
        assumptions.push("cache-write-upstream-zero");
      }
    }

    const costFresh = fresh * rate.input;
    const costCacheRead = cacheRead * (rate.cacheRead ?? rate.input);
    const costCacheWrite = cacheWrite * cacheWriteRate;
    const costOutput = output * rate.output;

    return {
      ...base,
      priced: true,
      rateSource: resolved.source,
      matchedKey: resolved.matchedKey,
      costFresh,
      costCacheRead,
      costCacheWrite,
      costOutput,
      total: costFresh + costCacheRead + costCacheWrite + costOutput,
      assumptions,
    };
  }

  function applyTier(rate, totalInput) {
    if (!Array.isArray(rate.tiers) || !rate.tiers.length) return rate;
    // tiers 按 over 升序，取最后一个「未超过」的档
    const sorted = [...rate.tiers].sort((a, b) => a.over - b.over);
    let chosen = rate;
    for (const t of sorted) {
      if (totalInput > t.over) {
        chosen = {
          ...rate,
          input: t.input ?? rate.input,
          output: t.output ?? rate.output,
          cacheRead: t.cacheRead ?? rate.cacheRead,
        };
      }
    }
    return chosen;
  }

  return {
    priceRow,
    rateFor,
    // 归因需要「该请求新增内容的单价」：新增内容不可能是缓存读取，故取输入单价。
    inputRateFor: (model, providerName, totalInput) => {
      const resolved = rateFor(model, providerName);
      if (!resolved) return 0;
      return applyTier(resolved.rate, num(totalInput)).input ?? 0;
    },
    unpricedModels: () => [...unpriced].sort(),
    stats,
    snapshotGeneratedAt: snapshot?.generatedAt ?? null,
    isSnapshotStale: () => {
      if (!snapshot?.generatedAt) return true;
      const ageDays = (Date.now() - Date.parse(snapshot.generatedAt)) / 86400000;
      return ageDays > STALE_DAYS_WARN;
    },
  };
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function priceRows(rows, pricer, providerNameFor = (r) => r.provider_name ?? null) {
  const priced = rows.map((r) => ({ row: r, price: pricer.priceRow(r, providerNameFor(r)) }));
  return {
    rows: priced,
    total: priced.reduce((a, x) => a + x.price.total, 0),
    priced: priced.filter((x) => x.price.priced),
    unpricedRows: priced.filter((x) => !x.price.priced),
  };
}
