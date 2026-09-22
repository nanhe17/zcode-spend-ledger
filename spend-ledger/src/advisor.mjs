// 建议引擎：把报告与成分分析转成可执行的结论，每条都带证据与可省估算。
//
// 原则：
//   • 每条建议都必须能追溯到具体数字或具体调用，不接受「一般来说」式建议。
//   • 可省估算是估算，字段名与文案都明确标注，不伪装成测量值。
//   • finding.id 由规则与作用对象稳定生成，账本据此去重，避免重复唠叨。
//   • 严重度看「可省金额」的量级，而不是规则本身的类别。
import { createHash } from "node:crypto";
import { mcpServerOf } from "./attribution.mjs";

const MCP_TOKENS_WORTH_FLAGGING = 1500; // 每轮固定开销超过此值才值得提示
const TOOL_OUTPUT_DOMINANCE = 0.35;
const SUBAGENT_SHARE_NOTICE = 0.2;
const CONTEXT_BLOAT_RATIO = 2.5;

function id(rule, key) {
  return createHash("sha1").update(`${rule}::${key}`).digest("hex").slice(0, 16);
}

function severityFor(savingCost, savingTokens, rate) {
  // 无法把 token 折算成金额时（例如全部模型未定价），按 token 量级分级，
  // 否则所有建议都会退化成 low，失去区分度。
  if (!rate || rate <= 0) {
    if (savingTokens >= 1_000_000) return "high";
    if (savingTokens >= 100_000) return "medium";
    return "low";
  }
  if (savingCost >= 0.5) return "high";
  if (savingCost >= 0.05) return "medium";
  return "low";
}

/**
 * @param {object} report      buildReport() 的结果
 * @param {object} [composition] analyzeComposition() 的结果
 * @param {object} [opts]      { inputRate } 用于把 token 折算成金额
 */
export function advise(report, composition = null, opts = {}) {
  if (!report?.ok) return { ok: false, error: "report-unavailable", findings: [] };
  const findings = [];
  const rate = opts.inputRate ?? averageInputRate(report);
  const push = (f) => findings.push({ ...f, severity: f.severity ?? severityFor((f.savingTokens ?? 0) * rate, f.savingTokens ?? 0, rate) });

  const totals = report.totals ?? {};
  const usedMcpServers = new Set(
    (report.toolsByBytes ?? []).map((t) => mcpServerOf(t.tool)).filter(Boolean)
  );

  // 1) 静态工具 schema 开销：每轮固定付费，与会话长短无关
  if (composition?.ok) {
    const agg = composition.aggregate;
    const analyzedSession = composition.sessionId ?? null;
    for (const s of agg.mcpServers) {
      if (s.perRequestTokens < MCP_TOKENS_WORTH_FLAGGING) continue;
      const used = usedMcpServers.has(s.server);
      const savingTokens = used ? 0 : s.totalTokens;
      push({
        id: id("mcp-schema-overhead", s.server),
        rule: "mcp-schema-overhead",
        title: `MCP 服务器 ${s.server} 每轮固定占用 ${Math.round(s.perRequestTokens).toLocaleString()} token`,
        evidence: {
          server: s.server,
          tools: s.tools,
          perRequestTokens: Math.round(s.perRequestTokens),
          analyzedRequests: agg.requestCount,
          analyzedSession,
          sessionTokens: Math.round(s.totalTokens),
          calledInAnalyzedRange: used,
        },
        savingTokens: Math.round(savingTokens),
        // 用量统计范围与成分分析范围可能不同（前者随 --scope，后者只针对单个会话），
        // 因此措辞限定在「被分析的这段请求」，并给出会话 id 供核对。
        recommendation: used
          ? `它在这段范围内被调用过，先确认是否每轮都需要；若只在特定任务里用，临时关闭可省下每轮固定开销。`
          : `在被分析的这段请求里它从未被调用过，却每轮都在为之付费。若不再需要，关闭该 MCP 服务器可省下约 ${Math.round(savingTokens).toLocaleString()} token。`,
      });
    }

    // 2) 工具 schema 总量占比过高
    const toolShare = agg.avgInputTokens > 0 ? agg.toolSchemaPerRequest / agg.avgInputTokens : 0;
    if (toolShare >= 0.15) {
      push({
        id: id("tool-schema-total", "session"),
        rule: "tool-schema-total",
        title: `工具定义占每轮上下文的 ${(toolShare * 100).toFixed(1)}%`,
        evidence: {
          perRequestTokens: Math.round(agg.toolSchemaPerRequest),
          native: Math.round(agg.nativeToolPerRequest),
          mcp: Math.round(agg.mcpPerRequest),
          avgInputTokens: Math.round(agg.avgInputTokens),
        },
        savingTokens: 0,
        recommendation: `这是每轮都要付的固定成本。削减不用的插件与 MCP 服务器是最直接的降本手段。`,
      });
    }
  }

  // 3) 标题生成等辅助开销
  const titleRow = (report.dimensions?.querySource ?? []).find((r) => r.key === "session_title");
  if (titleRow && titleRow.requests > 0 && titleRow.cost > 0) {
    push({
      id: id("aux-spend", "session_title"),
      rule: "aux-spend",
      title: `标题生成等辅助请求消耗了 ${titleRow.requests} 次请求`,
      evidence: { requests: titleRow.requests, tokens: titleRow.input + titleRow.output, cost: titleRow.cost },
      savingTokens: titleRow.input + titleRow.output,
      recommendation: "这部分通常无法直接关闭，但计入总账后可避免把它误当成对话开销。",
    });
  }

  // 4) 被中断或超上下文的重试：纯浪费
  const waste = (report.requests ?? []).filter((x) => x.row.context_exceeded || x.row.retry_count > 0 || x.row.cancelled_by_user);
  if (waste.length) {
    const wasteTokens = waste.reduce((a, x) => a + (x.row.input_tokens ?? 0) + (x.row.output_tokens ?? 0), 0);
    push({
      id: id("retry-waste", "session"),
      rule: "retry-waste",
      title: `${waste.length} 次请求因重试、超上下文或被取消而产生重复计费`,
      evidence: {
        requests: waste.length,
        contextExceeded: waste.filter((x) => x.row.context_exceeded).length,
        retried: waste.filter((x) => x.row.retry_count > 0).length,
        cancelled: waste.filter((x) => x.row.cancelled_by_user).length,
        tokens: wasteTokens,
      },
      savingTokens: wasteTokens,
      recommendation: "超上下文通常意味着该拆分会话。把长任务按主题拆开，比在压满的上下文里继续加内容更省。",
    });
  }

  // 5) 单个工具输出占据主导
  const bytesRows = report.toolsByBytes ?? [];
  const totalBytes = bytesRows.reduce((a, r) => a + r.outputBytes, 0);
  for (const r of bytesRows.slice(0, 3)) {
    const share = totalBytes > 0 ? r.outputBytes / totalBytes : 0;
    if (share < TOOL_OUTPUT_DOMINANCE) continue;
    push({
      id: id("tool-output-dominance", r.tool),
      rule: "tool-output-dominance",
      title: `${r.tool} 的输出占全部工具输出的 ${(share * 100).toFixed(0)}%`,
      evidence: { tool: r.tool, calls: r.calls, outputBytes: r.outputBytes, share },
      savingTokens: 0,
      recommendation:
        r.tool.startsWith("mcp__")
          ? "该 MCP 工具的输出体量很大。若只是为了一次性查看，避免在同一会话里重复调用，可显著降低后续每轮的上下文。"
          : "考虑对这类输出做过滤或截断后再进上下文，而不是整段读入。",
    });
  }

  // 6) 重复读取同一文件
  const fileRows = report.attribution?.files ?? [];
  const repeats = fileRows.filter((f) => f.calls >= 2);
  if (repeats.length) {
    const repeatedTokens = repeats.reduce((a, f) => a + f.tokens * (f.calls - 1) / f.calls, 0);
    push({
      id: id("repeated-reads", "session"),
      rule: "repeated-reads",
      title: `${repeats.length} 个文件被重复读取`,
      evidence: { files: repeats.slice(0, 5).map((f) => ({ file: f.key, calls: f.calls, tokens: Math.round(f.tokens) })) },
      savingTokens: Math.round(repeatedTokens),
      recommendation: "同一会话里重复读取同一文件，通常说明前一次读到的内容已经滑出注意力。先定位再读，或一次读够需要的范围。",
    });
  }

  // 7) 上下文膨胀：后半段每轮成本显著高于前半段
  const bloat = detectBloat(report);
  if (bloat) {
    push({
      id: id("context-bloat", report.scope?.sessionId ?? "session"),
      rule: "context-bloat",
      title: `后半段每轮输入是前半段的 ${bloat.ratio.toFixed(1)} 倍`,
      evidence: bloat,
      savingTokens: Math.round(bloat.excessTokens),
      recommendation: "上下文膨胀会让后续每一轮都更贵。在主题切换时新开会话，或先让 agent 总结已完成部分再继续。",
    });
  }

  // 8) 副代理占比
  const sub = (report.dimensions?.querySource ?? []).find((r) => r.key === "subagent");
  if (sub && totals.input > 0) {
    const share = sub.input / totals.input;
    if (share >= SUBAGENT_SHARE_NOTICE) {
      push({
        id: id("subagent-share", "session"),
        rule: "subagent-share",
        title: `副代理消耗了 ${(share * 100).toFixed(0)}% 的输入 token`,
        evidence: { requests: sub.requests, inputTokens: sub.input, cost: sub.cost, share },
        savingTokens: 0,
        recommendation: "用 Agent 做并行探索通常划算，但如果它每次返回的都是你已知道的信息，直接在主会话里读目标文件更省。",
      });
    }
  }

  findings.sort((a, b) => (b.savingTokens ?? 0) - (a.savingTokens ?? 0));
  return { ok: true, findings, rate, estimatedSavingTokens: findings.reduce((a, f) => a + (f.savingTokens ?? 0), 0) };
}

function detectBloat(report) {
  const turns = aggregateByTurn(report.requests ?? []);
  if (turns.length < 6) return null;
  const mid = Math.floor(turns.length / 2);
  const first = avg(turns.slice(0, mid).map((t) => t.input));
  const second = avg(turns.slice(mid).map((t) => t.input));
  if (first <= 0) return null;
  const ratio = second / first;
  if (ratio < CONTEXT_BLOAT_RATIO) return null;
  const excess = turns.slice(mid).reduce((a, t) => a + Math.max(0, t.input - first), 0);
  return { turns: turns.length, firstAvgInput: Math.round(first), secondAvgInput: Math.round(second), ratio, excessTokens: excess };
}

function aggregateByTurn(priced) {
  const m = new Map();
  for (const item of priced) {
    const key = item.row.turn_id ?? `${item.row.session_id}:orphan`;
    const g = m.get(key) ?? { key, input: 0, output: 0, requests: 0 };
    g.input += item.row.input_tokens ?? 0;
    g.output += item.row.output_tokens ?? 0;
    g.requests++;
    m.set(key, g);
  }
  return [...m.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function averageInputRate(report) {
  const priced = report.requests ?? [];
  const fresh = priced.reduce((a, x) => a + x.price.fresh, 0);
  const cost = priced.reduce((a, x) => a + x.price.costFresh, 0);
  return fresh > 0 ? cost / fresh : 0;
}

function avg(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}
