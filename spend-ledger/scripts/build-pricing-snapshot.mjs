// 构建定价快照：从 LiteLLM 与 models.dev 拉取权威定价，归一化为每 token 美元。
// 用法：node scripts/build-pricing-snapshot.mjs [--out data/pricing.snapshot.json]
//
// 两个上游的角色：
//   LiteLLM   每 token 计价，字段最全（含 cache_read / cache_creation 单价）
//   models.dev 每百万计价，带 context 分段 tiers，覆盖厂商更广
// 合并策略：同一模型名以先写入的非空字段为准，缺失字段由后者补齐。
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const LITELLM = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MODELS_DEV = "https://models.dev/api.json";

// 上游有大量经销商副本（302ai/…、abacus/…、accounts/fireworks/…），与规范名同价但会让
// 快照膨胀数十倍，因此只保留无命名空间的规范名，外加少量规范厂商前缀。
const CANONICAL_PREFIX = /^(zai|z-ai|zhipu|deepseek|moonshot|minimax|anthropic|openai|google|meta-llama|xai|alibaba|qwen)\//i;

const argOut = (() => {
  const i = process.argv.indexOf("--out");
  return i > -1 ? process.argv[i + 1] : "data/pricing.snapshot.json";
})();

const models = {};
const rejected = [];
const sources = [];

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function merge(prev, next) {
  const out = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (out[k] == null && v != null) out[k] = v;
  }
  return out;
}

function put(key, entry) {
  if (!key) return;
  let k = String(key).toLowerCase().trim();
  if (k.includes("/")) {
    if (!CANONICAL_PREFIX.test(k)) return;
    k = k.replace(CANONICAL_PREFIX, "");
    // 剥掉一层规范前缀后必须复查：上游存在 openai/chat-completion/models/xxx
    // 这类多层命名空间，只剥一层会留下带斜杠的伪规范名。
    if (k.includes("/")) return;
  }
  if (!k) return;
  models[k] = models[k] ? merge(models[k], entry) : entry;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "spend-ledger-pricing-snapshot" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// --- LiteLLM ---
try {
  const litellm = await getJson(LITELLM);
  let seen = 0;
  for (const [name, m] of Object.entries(litellm)) {
    if (!m || typeof m !== "object") continue;
    if (typeof m.input_cost_per_token !== "number") continue;
    seen++;
    put(name, {
      input: num(m.input_cost_per_token),
      output: num(m.output_cost_per_token),
      cacheRead: num(m.cache_read_input_token_cost),
      cacheWrite: num(m.cache_creation_input_token_cost),
      cacheWrite1h: num(m.cache_creation_input_token_cost_above_1hr),
      contextLimit: num(m.max_input_tokens) ?? num(m.max_tokens),
      outputLimit: num(m.max_output_tokens),
      source: "litellm",
    });
  }
  sources.push({ name: "litellm", url: LITELLM, scanned: seen, fetchedAt: new Date().toISOString() });
} catch (err) {
  sources.push({ name: "litellm", url: LITELLM, error: String(err.message) });
}

// --- models.dev ---
try {
  const md = await getJson(MODELS_DEV);
  const perToken = (v) => (typeof v === "number" ? v / 1e6 : null);
  let seen = 0;
  for (const [providerId, prov] of Object.entries(md)) {
    for (const [modelId, m] of Object.entries(prov?.models ?? {})) {
      const c = m?.cost;
      if (!c || typeof c.input !== "number") continue;
      seen++;
      put(modelId, {
        input: perToken(c.input),
        output: perToken(c.output),
        cacheRead: perToken(c.cache_read),
        cacheWrite: perToken(c.cache_write),
        contextLimit: num(m.limit?.context),
        outputLimit: num(m.limit?.output),
        tiers: Array.isArray(c.tiers)
          ? c.tiers
              .map((t) => ({
                over: num(t?.tier?.size),
                input: perToken(t.input),
                output: perToken(t.output),
                cacheRead: perToken(t.cache_read),
              }))
              .filter((t) => t.over != null)
          : null,
        source: `models.dev:${providerId}`,
      });
    }
  }
  sources.push({ name: "models.dev", url: MODELS_DEV, scanned: seen, fetchedAt: new Date().toISOString() });
} catch (err) {
  sources.push({ name: "models.dev", url: MODELS_DEV, error: String(err.message) });
}

// --- 校验：剔除「看起来有价、实际全零」的条目 ---
// 上游存在 input=0/output=0 的占位条目（多见于各种 token-plan 转售），
// 直接使用会让报告显示 $0 却看不出原因——这正是本项目要避免的静默归零。
const clean = {};
for (const [k, v] of Object.entries(models)) {
  const allZero = (v.input ?? 0) === 0 && (v.output ?? 0) === 0;
  const noInput = v.input == null;
  if (allZero || noInput) {
    rejected.push({ model: k, reason: noInput ? "missing-input-price" : "all-zero-price", source: v.source });
    continue;
  }
  clean[k] = v;
}

const snapshot = {
  version: 1,
  generatedAt: new Date().toISOString(),
  unit: "usd_per_token",
  sources,
  models: Object.fromEntries(Object.entries(clean).sort(([a], [b]) => a.localeCompare(b))),
  rejected,
};

mkdirSync(dirname(argOut), { recursive: true });
writeFileSync(argOut, JSON.stringify(snapshot, null, 1) + "\n");
const bytes = JSON.stringify(snapshot).length;
console.log(`wrote ${argOut}: ${Object.keys(clean).length} models, rejected ${rejected.length}, ~${(bytes / 1024).toFixed(0)} KB`);
console.log(JSON.stringify(sources, null, 1));
