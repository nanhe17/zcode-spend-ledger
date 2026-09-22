// 归因引擎。
//
// 维度归因（来源/代理/模式/模型）直接从 SQL 可得，是精确值。
//
// 工具与文件归因没有真值可用——ZCode 不记录「哪次工具调用吃掉了多少 token」，
// 因此这里用「增量归因」模型，并明确标注它是一个模型而不是测量：
//
//   同一 turn 内，请求按 started_at 排序。第 k 次请求相对第 k−1 次的上下文增量
//   为 delta = input_k − input_{k−1}。这个增量由三部分组成：
//     a) 第 k−1 次请求自身的输出（它作为历史进入下一轮上下文）
//     b) 第 k−1 到第 k 之间完成的工具调用的结果
//     c) 其他（用户消息、压缩重写、系统提示变化）
//   其中 (b) 按 output_bytes 加权分摊给具体工具，(a) 单独记为 assistant_carry，
//   剩余记为 residual。负增量（上下文压缩或窗口回退）单独记为 shrink，不做分摊。
//
// delta 部分是「新增内容」，不可能来自缓存，因此按新增输入单价计价。
//
// 输出中始终附带 coverage = 已归因 / 总增量，让读者知道模型解释了多少，
// 而不是把估算值冒充测量值。

export function summarize(priced) {
  const t = {
    requests: priced.length,
    input: 0,
    fresh: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    cost: 0,
    costFresh: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    costOutput: 0,
    unpricedRequests: 0,
    durationMs: 0,
    firstTokenMsSum: 0,
    firstTokenSamples: 0,
  };
  for (const { row, price } of priced) {
    t.input += n(row.input_tokens);
    t.fresh += price.fresh;
    t.cacheRead += price.cacheRead;
    t.cacheWrite += price.cacheWrite;
    t.output += n(row.output_tokens);
    t.reasoning += n(row.reasoning_tokens);
    t.cost += price.total;
    t.costFresh += price.costFresh;
    t.costCacheRead += price.costCacheRead;
    t.costCacheWrite += price.costCacheWrite;
    t.costOutput += price.costOutput;
    if (!price.priced) t.unpricedRequests++;
    t.durationMs += n(row.duration_ms);
    if (n(row.time_to_first_token_ms) > 0) {
      t.firstTokenMsSum += n(row.time_to_first_token_ms);
      t.firstTokenSamples++;
    }
  }
  t.avgFirstTokenMs = t.firstTokenSamples ? t.firstTokenMsSum / t.firstTokenSamples : null;
  t.cacheReadShare = t.input > 0 ? t.cacheRead / t.input : 0;
  return t;
}

export function rollupBy(priced, keyFn, keyLabel = "key") {
  const groups = new Map();
  for (const item of priced) {
    const key = keyFn(item.row) ?? "(unknown)";
    let g = groups.get(key);
    if (!g) {
      g = { [keyLabel]: key, requests: 0, input: 0, fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, unpricedRequests: 0 };
      groups.set(key, g);
    }
    g.requests++;
    g.input += n(item.row.input_tokens);
    g.fresh += item.price.fresh;
    g.cacheRead += item.price.cacheRead;
    g.cacheWrite += item.price.cacheWrite;
    g.output += n(item.row.output_tokens);
    g.cost += item.price.total;
    if (!item.price.priced) g.unpricedRequests++;
  }
  // 排序必须确定：输入量相同的情况下按费用、再按键名，避免同一份数据输出不同顺序
  const rows = [...groups.values()].sort((a, b) => b.input - a.input || b.cost - a.cost || String(a[keyLabel]).localeCompare(String(b[keyLabel])));
  const totalCost = rows.reduce((a, r) => a + r.cost, 0);
  const totalInput = rows.reduce((a, r) => a + r.input, 0);
  for (const r of rows) {
    r.shareCost = totalCost > 0 ? r.cost / totalCost : 0;
    r.shareInput = totalInput > 0 ? r.input / totalInput : 0;
  }
  return rows;
}

/**
 * 增量归因。
 * @param {Array} priced                 priceRows 的输出
 * @param {Array} tools                  toolRows() 的输出
 * @param {{rateForRow: (row)=>number}}  opts  取该请求的新增输入单价
 */
export function attributeIncrementally(priced, tools = [], opts = {}) {
  const rateForRow = opts.rateForRow ?? (() => 0);
  const detailsByCall = opts.detailsByCall ?? new Map();

  const toolsByTurn = new Map();
  for (const t of tools) {
    if (!t.turn_id) continue;
    if (!toolsByTurn.has(t.turn_id)) toolsByTurn.set(t.turn_id, []);
    toolsByTurn.get(t.turn_id).push(t);
  }

  const byTurn = new Map();
  for (const item of priced) {
    const key = item.row.turn_id ?? `orphan:${item.row.session_id}`;
    if (!byTurn.has(key)) byTurn.set(key, []);
    byTurn.get(key).push(item);
  }

  const toolAgg = new Map(); // tool_name -> totals
  const fileAgg = new Map(); // file_path -> totals
  const shrinkEvents = [];
  let growth = 0;
  let attributed = 0;
  let assistantCarry = 0;
  let shrinkTokens = 0;

  for (const [turnId, items] of byTurn) {
    if (items.length < 2) continue;
    items.sort((a, b) => n(a.row.started_at) - n(b.row.started_at));
    const turnTools = (toolsByTurn.get(turnId) ?? []).sort((a, b) => n(a.started_at) - n(b.started_at));

    const first = items[0].row;
    const last = items[items.length - 1].row;
    const turnGrowth = Math.max(0, n(last.input_tokens) - n(first.input_tokens));
    growth += turnGrowth;

    for (let k = 1; k < items.length; k++) {
      const prev = items[k - 1];
      const cur = items[k];
      const delta = n(cur.row.input_tokens) - n(prev.row.input_tokens);

      if (delta < 0) {
        shrinkTokens += -delta;
        shrinkEvents.push({
          sessionId: cur.row.session_id,
          turnId,
          at: n(cur.row.started_at),
          tokens: -delta,
          from: n(prev.row.input_tokens),
          to: n(cur.row.input_tokens),
        });
        continue;
      }

      // 上一条助手输出会作为历史进入本轮上下文，先从增量里扣除
      const carry = Math.min(delta, n(prev.row.output_tokens));
      assistantCarry += carry;
      const attributable = delta - carry;
      if (attributable <= 0) continue;

      const windowStart = n(prev.row.completed_at) || n(prev.row.started_at);
      const windowEnd = n(cur.row.started_at);
      const inWindow = turnTools.filter((t) => n(t.completed_at) >= windowStart && n(t.started_at) <= windowEnd);
      if (!inWindow.length) continue; // 无工具可归因 → 计入 residual

      const weights = inWindow.map((t) => Math.max(n(t.output_bytes), 1));
      const weightSum = weights.reduce((a, b) => a + b, 0);
      const rate = rateForRow(cur.row);
      attributed += attributable;

      inWindow.forEach((t, i) => {
        const tokens = (attributable * weights[i]) / weightSum;
        const cost = tokens * rate;
        bump(toolAgg, t.tool_name || "(unnamed)", tokens, cost, 1);
        const detail = detailsByCall.get(t.tool_call_id);
        const file = detail?.file_path ?? detail?.url ?? null;
        if (file) bump(fileAgg, file, tokens, cost, 1, { tool: t.tool_name });
      });
    }
  }

  const coverage = growth > 0 ? attributed / growth : 0;
  return {
    coverage,
    growth,
    attributed,
    assistantCarry,
    shrinkTokens,
    residual: Math.max(0, growth - attributed - assistantCarry),
    shrinkEvents,
    tools: finalize(toolAgg),
    files: finalize(fileAgg),
  };
}

function bump(map, key, tokens, cost, calls, extra = {}) {
  let e = map.get(key);
  if (!e) {
    e = { key, tokens: 0, cost: 0, calls: 0, ...extra };
    map.set(key, e);
  }
  e.tokens += tokens;
  e.cost += cost;
  e.calls += calls;
}

function finalize(map) {
  const rows = [...map.values()].sort((a, b) => b.tokens - a.tokens);
  const total = rows.reduce((a, r) => a + r.tokens, 0);
  for (const r of rows) r.share = total > 0 ? r.tokens / total : 0;
  return rows;
}

// MCP 工具名形如 mcp__<server>__<tool>；插件命名空间会再套一层 plugin_<a>_<b>。
export function mcpServerOf(toolName) {
  if (!toolName?.startsWith("mcp__")) return null;
  const rest = toolName.slice("mcp__".length);
  const sep = rest.indexOf("__");
  let server = sep === -1 ? rest : rest.slice(0, sep);
  if (server.startsWith("plugin_")) server = server.slice("plugin_".length).split("_")[0];
  return server;
}

export function rollupMcpServers(priced, tools) {
  const byId = new Map();
  for (const t of tools) byId.set(t.tool_call_id, t);
  const groups = new Map();
  for (const t of tools) {
    const server = mcpServerOf(t.tool_name);
    if (!server) continue;
    let g = groups.get(server);
    if (!g) {
      g = { server, calls: 0, outputBytes: 0, durationMs: 0, tools: new Set() };
      groups.set(server, g);
    }
    g.calls++;
    g.outputBytes += n(t.output_bytes);
    g.durationMs += n(t.duration_ms);
    g.tools.add(t.tool_name);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, toolCount: g.tools.size, tools: [...g.tools].sort() }))
    .sort((a, b) => b.outputBytes - a.outputBytes);
}

export function rollupToolsByBytes(tools) {
  const groups = new Map();
  for (const t of tools) {
    const name = t.tool_name || "(unnamed)";
    let g = groups.get(name);
    if (!g) {
      g = { tool: name, calls: 0, outputBytes: 0, durationMs: 0, errors: 0, readOnly: 0 };
      groups.set(name, g);
    }
    g.calls++;
    g.outputBytes += n(t.output_bytes);
    g.durationMs += n(t.duration_ms);
    if (t.status && t.status !== "completed") g.errors++;
    if (n(t.read_only) === 1) g.readOnly++;
  }
  return [...groups.values()].sort((a, b) => b.outputBytes - a.outputBytes);
}

function n(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
