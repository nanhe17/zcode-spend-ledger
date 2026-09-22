// 建议引擎：把报告与静态构成分析转成可执行的结论，每条都带证据与可省估算。
//
// 最关键的设计是**每条结论都必须声明按什么单价折算**，因为不同内容的边际成本差 41 倍：
// 实测本机数据里，新增输入单价约 4.04e-7 美元/token，缓存读取约 9.83e-9 美元/token。
// 早先版本把静态工具 schema（实际几乎全命中缓存）也按新增输入单价折算，
// 于是把「省 $0.05」说成了「省 $2.06」——高估 41 倍。现在用 savingKind 强制区分：
//
//   tokens-fresh   新进入上下文的内容（工具结果、重复读取），按新增输入单价
//   tokens-cached  被反复重发的上下文（膨胀的上下文、重试），按实测缓存读取单价
//   chars-static   常驻缓存的静态内容（工具 schema），只报字符与占比，不折算金额
//   none           纯信息性，无可省估算
//
// 其余原则：每条都能追溯到具体数字或具体调用；id 稳定以便账本去重。
import { createHash } from "node:crypto";
import { mcpServerOf } from "./attribution.mjs";

function id(rule, key) {
  return createHash("sha1").update(`${rule}::${key}`).digest("hex").slice(0, 16);
}

const SAVING_KINDS = ["tokens-fresh", "tokens-cached", "chars-static", "none"];

/**
 * @param {object} report      buildReport() 的结果
 * @param {object} [composition] analyzeComposition() 的结果
 * @param {object} [opts]      { freshRate, cacheReadRate } 可覆盖实测单价
 */
export function advise(report, composition = null, opts = {}) {
  if (!report?.ok) return emptyResult("report-unavailable");
  const totals = report.totals ?? {};

  // 单价一律用**使用者自己的实测数据**推算，而不是定价表上的标价：
  // 实测值已经把缓存读写、分段计价、实际模型混合都包含了，更贴近真实边际成本。
  const freshRate = opts.freshRate ?? ratio(totals.costFresh, totals.fresh);
  const cacheReadRate = opts.cacheReadRate ?? ratio(totals.costCacheRead, totals.cacheRead);

  const findings = [];
  const push = (f) => {
    const kind = SAVING_KINDS.includes(f.savingKind) ? f.savingKind : "none";
    const savingTokens = f.savingTokens ?? 0;
    const usd = kind === "tokens-fresh" ? savingTokens * freshRate : kind === "tokens-cached" ? savingTokens * cacheReadRate : 0;
    findings.push({
      ...f,
      savingKind: kind,
      savingTokens: kind === "tokens-fresh" || kind === "tokens-cached" ? savingTokens : 0,
      savingChars: f.savingChars ?? 0,
      savingUsd: usd,
      severity: f.severity ?? severityFor({ kind, usd, tokens: savingTokens, chars: f.savingChars ?? 0, share: f.share ?? 0 }),
    });
  };

  const usedMcpServers = new Set((report.toolsByBytes ?? []).map((t) => mcpServerOf(t.tool)).filter(Boolean));

  // 1) 常驻的 MCP 工具 schema：只报字符与占比，不折算金额
  if (composition?.ok) {
    const agg = composition.aggregate;
    for (const s of agg.servers) {
      if (s.chars < 2000) continue; // 太小的不值得提示
      const used = usedMcpServers.has(s.server);
      push({
        id: id("mcp-schema-overhead", s.server),
        rule: "mcp-schema-overhead",
        savingKind: "chars-static",
        savingChars: used ? 0 : s.chars,
        share: s.shareOfToolSchemas,
        title: `MCP 服务器 ${s.server} 的 ${s.tools} 个工具定义占工具 schema 的 ${(s.shareOfToolSchemas * 100).toFixed(1)}%`,
        evidence: {
          server: s.server,
          tools: s.tools,
          chars: s.chars,
          shareOfToolSchemas: Number(s.shareOfToolSchemas.toFixed(4)),
          calledInAnalyzedRange: used,
          analyzedRequests: agg.requestCount,
          // 不给绝对 token 数：那需要分词假设，权威值在内置「上下文容量」面板
        },
        recommendation: used
          ? `它在这段范围内被调用过。工具定义是每轮都要重发的常驻内容，若只在特定任务里用，临时关闭可减少上下文占用。`
          : `在被分析的这段请求里它从未被调用过，其工具定义却每轮都在上下文里。关闭它可让每轮少 ${s.chars.toLocaleString()} 字符的工具定义（占工具定义的 ${(s.shareOfToolSchemas * 100).toFixed(1)}%）。`,
        //
        // 成本提示必须说清：这部分内容通常命中缓存，美元影响很小（约为新增输入的 1/41），
        // 真实收益是上下文窗口与长会话余量。
        basis: "按字符与占比衡量，不折算金额：该项常驻缓存，美元影响很小",
      });
    }
  }

  // 2) 辅助请求（标题生成等）：确实花了钱
  const titleRow = (report.dimensions?.querySource ?? []).find((r) => r.key === "session_title");
  if (titleRow?.requests > 0 && titleRow.cost > 0) {
    push({
      id: id("aux-spend", "session_title"),
      rule: "aux-spend",
      savingKind: "tokens-fresh",
      savingTokens: titleRow.fresh + titleRow.output,
      title: `标题生成等辅助请求消耗了 ${titleRow.requests} 次请求`,
      evidence: { requests: titleRow.requests, tokens: titleRow.input + titleRow.output, cost: Number(titleRow.cost.toFixed(6)) },
      recommendation: "这部分通常无法直接关闭，但单独计账可避免把它误当成对话开销。",
      basis: "新增输入与输出 token × 实测新增输入单价",
    });
  }

  // 3) 重试与超上下文：被反复重发的上下文按缓存读取单价算
  const waste = (report.requests ?? []).filter((x) => x.row.context_exceeded || x.row.retry_count > 0 || x.row.cancelled_by_user);
  if (waste.length) {
    const wasteTokens = waste.reduce((a, x) => a + (x.row.input_tokens ?? 0), 0);
    push({
      id: id("retry-waste", "session"),
      rule: "retry-waste",
      savingKind: "tokens-cached",
      savingTokens: wasteTokens,
      title: `${waste.length} 次请求因重试、超上下文或被取消而重复发送了上下文`,
      evidence: {
        requests: waste.length,
        contextExceeded: waste.filter((x) => x.row.context_exceeded).length,
        retried: waste.filter((x) => x.row.retry_count > 0).length,
        cancelled: waste.filter((x) => x.row.cancelled_by_user).length,
        resentInputTokens: wasteTokens,
      },
      recommendation: "超上下文通常意味着该拆分会话。把长任务按主题拆开，比在压满的上下文里继续加内容更省。",
      basis: "重发的是已有上下文，按实测缓存读取单价折算（保守口径）",
    });
  }

  // 4) 单个工具输出占据主导（信息性）
  const bytesRows = report.toolsByBytes ?? [];
  const totalBytes = bytesRows.reduce((a, r) => a + r.outputBytes, 0);
  for (const r of bytesRows.slice(0, 3)) {
    const share = totalBytes > 0 ? r.outputBytes / totalBytes : 0;
    if (share < 0.35) continue;
    push({
      id: id("tool-output-dominance", r.tool),
      rule: "tool-output-dominance",
      savingKind: "none",
      title: `${r.tool} 的输出占全部工具输出的 ${(share * 100).toFixed(0)}%`,
      evidence: { tool: r.tool, calls: r.calls, outputBytes: r.outputBytes, share: Number(share.toFixed(4)) },
      recommendation: r.tool.startsWith("mcp__")
        ? "该 MCP 工具输出体量很大。避免在同一会话里重复调用，可显著减少后续每轮的上下文。"
        : "考虑对这类输出做过滤或截断后再进上下文，而不是整段读入。",
      basis: "信息性：未做折算，因为可省量取决于你实际会读多少",
    });
  }

  // 5) 重复读取同一文件：新进内容，按新增输入单价
  const repeats = (report.attribution?.files ?? []).filter((f) => f.calls >= 2);
  if (repeats.length) {
    const repeatedTokens = repeats.reduce((a, f) => a + (f.tokens * (f.calls - 1)) / f.calls, 0);
    push({
      id: id("repeated-reads", "session"),
      rule: "repeated-reads",
      savingKind: "tokens-fresh",
      savingTokens: Math.round(repeatedTokens),
      title: `${repeats.length} 个文件被重复读取`,
      evidence: { files: repeats.slice(0, 5).map((f) => ({ file: f.key, calls: f.calls, tokens: Math.round(f.tokens) })) },
      recommendation: "同一会话里重复读取同一文件，通常说明前一次读到的内容已经滑出注意力。先定位再读，或一次读够需要的范围。",
      basis: "重复读取的内容是新增输入 × 实测新增输入单价",
    });
  }

  // 6) 上下文膨胀：膨胀部分被每轮重发，按缓存读取单价
  const bloat = detectBloat(report);
  if (bloat) {
    push({
      id: id("context-bloat", report.scope?.sessionId ?? "session"),
      rule: "context-bloat",
      savingKind: "tokens-cached",
      savingTokens: Math.round(bloat.excessTokens),
      title: `后半段每轮输入是前半段的 ${bloat.ratio.toFixed(1)} 倍`,
      evidence: bloat,
      recommendation: "上下文膨胀会让后续每一轮都更贵。在主题切换时新开会话，或先让 agent 总结已完成部分再继续。",
      basis: "超出部分是每轮重发的上下文，按实测缓存读取单价折算",
    });
  }

  // 7) 副代理占比（信息性）
  const sub = (report.dimensions?.querySource ?? []).find((r) => r.key === "subagent");
  if (sub && totals.input > 0) {
    const share = sub.input / totals.input;
    if (share >= 0.2) {
      push({
        id: id("subagent-share", "session"),
        rule: "subagent-share",
        savingKind: "none",
        title: `副代理消耗了 ${(share * 100).toFixed(0)}% 的输入 token`,
        evidence: { requests: sub.requests, inputTokens: sub.input, cost: Number(sub.cost.toFixed(6)), share: Number(share.toFixed(4)) },
        recommendation: "用 Agent 做并行探索通常划算，但如果它每次返回的都是你已知道的信息，直接在主会话里读目标文件更省。",
        basis: "信息性：副代理本身不是浪费，是否值得取决于产出",
      });
    }
  }

  findings.sort((a, b) => b.savingUsd - a.savingUsd || b.savingChars - a.savingChars || b.savingTokens - a.savingTokens);

  return {
    ok: true,
    findings,
    rates: { fresh: freshRate, cacheRead: cacheReadRate, source: opts.freshRate ? "override" : "observed" },
    estimatedSaving: {
      freshTokens: findings.filter((f) => f.savingKind === "tokens-fresh").reduce((a, f) => a + f.savingTokens, 0),
      cachedTokens: findings.filter((f) => f.savingKind === "tokens-cached").reduce((a, f) => a + f.savingTokens, 0),
      staticChars: findings.filter((f) => f.savingKind === "chars-static").reduce((a, f) => a + f.savingChars, 0),
      usd: findings.reduce((a, f) => a + f.savingUsd, 0),
    },
  };
}

function emptyResult(error) {
  return { ok: false, error, findings: [], rates: { fresh: 0, cacheRead: 0 }, estimatedSaving: { freshTokens: 0, cachedTokens: 0, staticChars: 0, usd: 0 } };
}

function severityFor({ kind, usd, tokens, chars, share }) {
  if (kind === "chars-static") {
    // 按占工具定义的比例分级；这类内容金额影响小，信号量在"占多少"
    if (share >= 0.2) return "high";
    if (share >= 0.08) return "medium";
    return "low";
  }
  if (usd > 0) {
    if (usd >= 0.5) return "high";
    if (usd >= 0.05) return "medium";
    return "low";
  }
  // 换算不出金额时按量级分级，避免一律退化成 low
  const volume = tokens || chars;
  if (volume >= 1_000_000) return "high";
  if (volume >= 100_000) return "medium";
  return "low";
}

// 上下文膨胀检测。
//
// 必须区分两件事，早先版本把二者混为一谈：
//   • 上下文规模 = 单次请求的 input_tokens（这是"上下文有多大"）
//   • 工作量     = 一轮内所有请求的 input 之和（这还乘上了"轮内请求数"）
// 用求和值当"每轮输入"会把轮内请求数误读成上下文增长（实测曾得出"每轮 1890 万 token"这种
// 超过模型上下文上限的数字）。因此膨胀按单次请求的上下文规模判断，
// 可省量则从"上下文规模超出基线"这个反事实推算。
function detectBloat(report) {
  const withTurn = (report.requests ?? [])
    .filter((x) => (x.row.input_tokens ?? 0) > 0)
    .map((x) => ({ turn: x.row.turn_id ?? `${x.row.session_id}:orphan`, input: x.row.input_tokens, at: x.row.started_at ?? 0 }));
  // 样本太少时前后半段的均值不稳定，容易误报；轮数与请求数都设下限
  if (withTurn.length < 8) return null;

  const turns = new Map();
  for (const r of withTurn) {
    const g = turns.get(r.turn) ?? { key: r.turn, first: r.at, inputs: [] };
    g.first = Math.min(g.first, r.at);
    g.inputs.push(r.input);
    turns.set(r.turn, g);
  }
  // 按时间排序，"前半段/后半段"才是时间意义上的前后
  const ordered = [...turns.values()].sort((a, b) => a.first - b.first);
  if (ordered.length < 6) return null;

  const mid = Math.floor(ordered.length / 2);
  const firstHalf = ordered.slice(0, mid);
  const secondHalf = ordered.slice(mid);
  const firstAvg = avg(firstHalf.map((t) => avg(t.inputs)));
  const secondAvg = avg(secondHalf.map((t) => avg(t.inputs)));
  if (firstAvg <= 0) return null;
  const ratio = secondAvg / firstAvg;
  if (ratio < 2.5) return null;

  // 反事实：若后半段的每次请求都维持前半段的上下文规模，能少发多少 token
  const excess = secondHalf.reduce((a, t) => a + t.inputs.reduce((s, v) => s + Math.max(0, v - firstAvg), 0), 0);

  return {
    turns: ordered.length,
    firstAvgContext: Math.round(firstAvg),
    secondAvgContext: Math.round(secondAvg),
    ratio: Number(ratio.toFixed(2)),
    excessTokens: Math.round(excess),
    basisNote: "上下文规模 = 单次请求的 input_tokens；可省量为超出前半段基线的部分",
  };
}

function averageInputRate(report) {
  const priced = report.requests ?? [];
  const fresh = priced.reduce((a, x) => a + x.price.fresh, 0);
  const cost = priced.reduce((a, x) => a + x.price.costFresh, 0);
  return ratio(cost, fresh);
}

function ratio(cost, tokens) {
  return tokens > 0 ? cost / tokens : 0;
}

function avg(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}
