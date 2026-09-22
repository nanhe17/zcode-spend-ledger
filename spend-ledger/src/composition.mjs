// 上下文成分分析（差异化核心）。
//
// 数据源：~/.zcode/cli/rollout/model-io-<sessionId>.jsonl，每个模型请求一行，
// 含请求体（system 块、tools schema、messages）与实测 usage。
// 这是 ZCode 里唯一能看到「上下文由什么构成」的地方——DB 只给总数。
//
// 数据形状有三个必须知道的坑（都是实测确认的，写错会让结论整体失真）：
//
//  1) request.messages 不是完整会话，而是窗口。request.messagesKind 取 full / delta / tail：
//       delta 只记新增的几条，tail 只记最近 N 条，request.messageCount 才是会话总条数。
//     因此绝不能把 messages 的字符占比当成历史占比再放大到实测总量。
//
//  2) request.body.system 与 request.body.tools 在每条记录里都是全量。
//     实测 82 条记录：system 恒为 7,804 字符、tools 恒为 133,492 字符，与 messagesKind 无关。
//     所以静态开销是逐条可精确计算的，这是本模块最可靠的输出。
//
//  3) 请求里还有 tool_choice、thinking 等未建模字段，它们的 token 会被残差吸收。
//
// 方法（两段式）：
//   标定：只在 messagesKind === 'full' 的记录上，用「整段内容」的加权长度对实测 inputTokens
//         求 token 密度（tokens / 加权字符）。这些记录的 messages 是完整的，密度可信。
//   应用：对每条记录，静态 token = 加权长度(system + tools) × 密度；
//         历史 token = 实测 inputTokens − 静态（残差，自动包含未被记录的消息与未建模字段）。
//
//   于是「静态开销」是可靠的主结论，「历史细分」只在 full 记录上给出并明确标注样本数。
//
// 隐私：默认只输出类别名与 token 数，绝不输出提示原文。includeText 才附带片段。
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { zcodePaths } from "./paths.mjs";
import { mcpServerOf } from "./attribution.mjs";

const CJK = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;

// 无 full 记录可标定时的兜底密度（JSON 密集的英文约 1 token / 3.5 字符）
const DEFAULT_DENSITY = 1.1;

// 加权长度：CJK 每字符约 0.75 token，其余约 0.25 token。
// 绝对值不重要（会乘上标定出的密度），重要的是 CJK 与 ASCII 的相对权重。
export function weightedLength(text) {
  const s = String(text ?? "");
  let cjk = 0;
  let other = 0;
  for (const ch of s) (CJK.test(ch) ? cjk++ : other++);
  return { chars: s.length, cjk, weighted: cjk * 0.75 + other * 0.25 };
}

export function modelIoPath(sessionId, env = process.env) {
  return join(zcodePaths(env).rolloutDir, `model-io-${sessionId}.jsonl`);
}

export async function analyzeComposition(opts = {}) {
  const env = opts.env ?? process.env;
  const sessionId = opts.sessionId;
  if (!sessionId) return { ok: false, error: "session-id-required" };

  const file = opts.file ?? modelIoPath(sessionId, env);
  if (!existsSync(file)) return { ok: false, error: "model-io-not-found", file, sessionId };

  const limit = Number(opts.maxRequests ?? 0);
  const records = [];
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    records.push(obj);
    if (limit > 0 && records.length > limit) records.shift();
  }
  if (!records.length) return { ok: false, error: "model-io-empty", file, sessionId };

  const calibration = calibrate(records);
  const perRequest = records.map((rec) => analyzeOne(rec, calibration.density, opts.includeText === true));

  return {
    ok: true,
    sessionId,
    file,
    requestCount: perRequest.length,
    firstAt: perRequest[0]?.at ?? null,
    lastAt: perRequest[perRequest.length - 1]?.at ?? null,
    calibration,
    perRequest,
    aggregate: aggregateAll(perRequest, calibration),
    warnings: buildWarnings(perRequest, calibration),
    assumptions: [
      "static-observed-history-residual",
      "unmodeled-fields-prorated-into-history",
      ...(calibration.source === "default" ? ["density-fallback-used"] : []),
      ...(opts.includeText ? ["text-included"] : ["text-omitted-for-privacy"]),
    ],
  };
}

// 标定：用 messagesKind === 'full' 的记录求 token 密度
function calibrate(records) {
  const fulls = records.filter((r) => r.request?.messagesKind === "full");
  if (!fulls.length) {
    return {
      source: "default",
      density: DEFAULT_DENSITY,
      samples: 0,
      caveat: "没有 messagesKind=full 的记录可用于标定（通常因为会话过长、早期记录已被滚动移除），已使用默认密度，静态占比仍可比，绝对值误差可能较大。",
    };
  }
  let observed = 0;
  let weighted = 0;
  for (const rec of fulls) {
    observed += num(rec.response?.usage?.inputTokens);
    weighted += contentWeighted(rec).weighted;
  }
  return {
    source: "full-records",
    density: weighted > 0 ? observed / weighted : DEFAULT_DENSITY,
    samples: fulls.length,
    observedTokens: observed,
    weightedChars: weighted,
    note: "密度由 full 记录的整段内容对实测 inputTokens 求得。",
  };
}

function contentWeighted(rec) {
  let weighted = 0;
  let chars = 0;
  for (const b of rec.request?.body?.system ?? []) {
    const w = weightedLength(b?.text ?? "");
    weighted += w.weighted;
    chars += w.chars;
  }
  for (const t of rec.request?.body?.tools ?? []) {
    const w = weightedLength(JSON.stringify(t));
    weighted += w.weighted;
    chars += w.chars;
  }
  for (const m of rec.request?.messages ?? []) {
    const w = weightedLength(typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
    weighted += w.weighted;
    chars += w.chars;
  }
  return { weighted, chars };
}

function analyzeOne(rec, density, includeText) {
  const body = rec.request?.body ?? {};
  const usage = rec.response?.usage ?? {};

  let systemW = 0;
  let systemChars = 0;
  const systemParts = [];
  for (const b of body.system ?? []) {
    const w = weightedLength(b?.text ?? "");
    systemW += w.weighted;
    systemChars += w.chars;
    if (includeText && systemParts.length < 3) systemParts.push(String(b?.text ?? "").slice(0, 120));
  }

  let toolsW = 0;
  let toolsChars = 0;
  let nativeW = 0;
  let nativeChars = 0;
  let nativeCount = 0;
  const mcpMap = new Map();
  for (const tool of body.tools ?? []) {
    const text = JSON.stringify(tool);
    const w = weightedLength(text);
    toolsW += w.weighted;
    toolsChars += w.chars;
    const server = mcpServerOf(tool?.name ?? "");
    if (server) {
      let g = mcpMap.get(server);
      if (!g) {
        g = { server, tools: 0, weighted: 0, chars: 0 };
        mcpMap.set(server, g);
      }
      g.tools++;
      g.weighted += w.weighted;
      g.chars += w.chars;
    } else {
      nativeW += w.weighted;
      nativeChars += w.chars;
      nativeCount++;
    }
  }

  const observed = num(usage.inputTokens);
  const staticTokens = (systemW + toolsW) * density;
  const systemTokens = systemW * density;
  const toolsTokens = toolsW * density;
  const nativeTokens = nativeW * density;
  const mcpTokens = toolsW > 0 ? toolsTokens * (1 - nativeW / toolsW) : 0;
  // 历史 = 实测 − 静态：残差天然吸收了未被记录的消息与未建模字段
  const historyTokens = Math.max(0, observed - staticTokens);

  const mcpServers = [...mcpMap.values()]
    .map((g) => ({
      server: g.server,
      tools: g.tools,
      chars: g.chars,
      tokens: toolsW > 0 ? (g.weighted / toolsW) * toolsTokens : 0,
      shareOfRequest: observed > 0 ? ((g.weighted / toolsW) * toolsTokens) / observed : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  // 历史细分只在 full 记录上可信，因为只有它记录了完整 messages
  const kind = rec.request?.messagesKind ?? "unknown";
  const historyBreakdown = kind === "full" ? breakdownHistory(rec.request?.messages ?? [], density) : null;

  return {
    requestId: rec.requestId ?? null,
    turnId: rec.turnId ?? null,
    at: num(rec.startedAt),
    model: rec.model?.modelId ?? body.model ?? null,
    querySource: rec.querySource ?? null,
    messagesKind: kind,
    messageCount: num(rec.request?.messageCount),
    loggedMessages: (rec.request?.messages ?? []).length,
    observedInputTokens: observed,
    observedCacheRead: num(usage.cacheReadTokens),
    observedOutput: num(usage.outputTokens),
    systemTokens,
    toolsTokens,
    nativeToolTokens: nativeTokens,
    mcpTokens,
    nativeToolCount: nativeCount,
    mcpToolCount: [...mcpMap.values()].reduce((a, g) => a + g.tools, 0),
    staticTokens,
    staticShare: observed > 0 ? staticTokens / observed : 0,
    historyTokens,
    historyShare: observed > 0 ? historyTokens / observed : 0,
    mcpServers,
    historyBreakdown,
    ...(includeText && systemParts.length ? { systemSamples: systemParts } : {}),
  };
}

function breakdownHistory(messages, density) {
  const acc = { user: 0, assistant: 0, tool: 0, system: 0, other: 0 };
  for (const m of messages) {
    const w = weightedLength(typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
    const role = ["user", "assistant", "tool", "system"].includes(m?.role) ? m.role : "other";
    acc[role] += w.weighted * density;
  }
  return acc;
}

function aggregateAll(perRequest, calibration) {
  const n = perRequest.length;
  const sum = (fn) => perRequest.reduce((a, r) => a + fn(r), 0);
  const observed = sum((r) => r.observedInputTokens);
  const staticTokens = sum((r) => r.staticTokens);
  const toolsTokens = sum((r) => r.toolsTokens);
  const nativeToolTokens = sum((r) => r.nativeToolTokens);
  const mcpTokens = sum((r) => r.mcpTokens);
  const systemTokens = sum((r) => r.systemTokens);
  const historyTokens = sum((r) => r.historyTokens);

  const mcp = new Map();
  for (const r of perRequest) {
    for (const s of r.mcpServers) {
      let g = mcp.get(s.server);
      if (!g) {
        g = { server: s.server, tools: s.tools, totalTokens: 0, perRequestTokens: 0, chars: s.chars };
        mcp.set(s.server, g);
      }
      g.totalTokens += s.tokens;
      g.perRequestTokens += s.tokens / n;
    }
  }

  const fulls = perRequest.filter((r) => r.historyBreakdown);
  const historyBreakdown = fulls.length
    ? {
        samples: fulls.length,
        note: "仅统计 messagesKind=full 的请求（这些请求的 messages 是完整的）",
        perRequest: Object.fromEntries(
          ["user", "assistant", "tool", "system", "other"].map((k) => [k, fulls.reduce((a, r) => a + r.historyBreakdown[k], 0) / fulls.length])
        ),
      }
    : null;

  return {
    requestCount: n,
    totalObservedInputTokens: observed,
    avgInputTokens: observed / n,
    systemTokens,
    systemPerRequest: systemTokens / n,
    toolsTokens,
    toolSchemaPerRequest: toolsTokens / n,
    nativeToolTokens,
    nativeToolPerRequest: nativeToolTokens / n,
    mcpTokens,
    mcpPerRequest: mcpTokens / n,
    staticTokens,
    staticPerRequest: staticTokens / n,
    staticShare: observed > 0 ? staticTokens / observed : 0,
    historyTokens,
    historyPerRequest: historyTokens / n,
    historyShare: observed > 0 ? historyTokens / observed : 0,
    mcpServers: [...mcp.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    historyBreakdown,
    calibration,
  };
}

function buildWarnings(perRequest, calibration) {
  const w = [];
  if (calibration.source === "default") w.push("no-full-records-for-calibration");
  if (perRequest.some((r) => r.staticShare > 1.001)) w.push("static-exceeds-observed");
  // 静态开销的绝对值本应逐轮恒定（system 与 tools 是全量且不变）。
  // 若波动明显，说明会话中途工具集变了（MCP 服务器重连、插件启停等）——这是真信号。
  const statics = perRequest.map((r) => r.staticTokens).filter((v) => v > 0);
  if (statics.length > 1) {
    const ratio = Math.max(...statics) / Math.min(...statics);
    if (ratio > 1.3) w.push("static-overhead-changed-mid-session");
  }
  const kinds = new Set(perRequest.map((r) => r.messagesKind));
  if (kinds.has("delta") || kinds.has("tail")) w.push("messages-windowed-history-is-residual");
  return w;
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
