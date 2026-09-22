// 上下文静态构成分析。
//
// 这个模块刻意**不**估算绝对 token 数。原因有三条实测证据：
//
//  1) 单一全局 token 密度不可靠。用「加权长度 × 单一密度」估算静态部分得到 40,873 token，
//     而 ZCode 内置「上下文容量」面板对同一内容给出 75,425 token（面板分母恰为本次请求的
//     input_tokens，344,408，与库内数值精确吻合）。两者差 1.85 倍，因为工具 schema 是
//     JSON 密集内容，密度显著高于散文，被全局密度平均掉了。
//
//  2) 用最小二乘反解静态值不可行。`input_tokens = 静态 + b × 消息长度` 看似可解，
//     但 messagesKind=full 的记录只出现在会话开头，消息长度区间很窄，
//     外推到 x=0 得到病态结果（实测截距 13,236、静态密度 4.88 token/加权字符，物理上不可能）。
//     见 scripts/fit-static-probe.mjs。
//
//  3) 权威数字读不到。宿主没有把成分分类落库（`timeline` part 只是模型切换标记，
//     `step-finish` 只有聚合 token），面板是客户端按它自己构建的请求实时算的。
//
// 因此本模块只输出**精确、无需密度假设**的东西：
//   • 系统提示与工具 schema 的字符量（逐条实测，且可验证其在整个会话内恒定）
//   • 每个 MCP 服务器占工具 schema 的字符与占比（占比与密度无关，密度会约掉）
//   • 构成一致性检查：若会话中途工具集变化，字符量会变，这是真信号
//
// 绝对 token 构成请交给 ZCode 内置的「上下文容量」面板，那是权威来源。
//
// 隐私：只输出类别名、字符数与占比，绝不输出提示原文。
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { zcodePaths } from "./paths.mjs";
import { mcpServerOf } from "./attribution.mjs";

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

  const perRequest = records.map(measureOne);
  const aggregate = aggregateAll(perRequest);

  return {
    ok: true,
    sessionId,
    file,
    requestCount: perRequest.length,
    firstAt: perRequest[0]?.at ?? null,
    lastAt: perRequest[perRequest.length - 1]?.at ?? null,
    window: {
      retainedRequests: perRequest.length,
      firstAt: perRequest[0]?.at ?? null,
      lastAt: perRequest[perRequest.length - 1]?.at ?? null,
      spanMs: (perRequest[perRequest.length - 1]?.at ?? 0) - (perRequest[0]?.at ?? 0),
      rolling: true,
      note:
        "model-io 是滚动窗口（按体积截断），只保留最近的请求，因此 retainedRequests 不等于会话的请求总数。" +
        "同一会话在不同时刻运行，覆盖的请求范围会不同。",
    },
    perRequest,
    aggregate,
    consistency: checkConsistency(perRequest),
    warnings: buildWarnings(perRequest),
    authority: {
      absoluteTokens: "zcode-built-in-panel",
      note: "绝对 token 构成请查看 ZCode 的「上下文容量」面板：它用客户端自身的记账，比这里的字符量推算准确。本模块只提供它没有的按 MCP 服务器细分。",
    },
    assumptions: ["chars-only-no-token-estimate", "text-omitted-for-privacy"],
  };
}

// 单条记录：只测量字符，不做任何 token 估算
function measureOne(rec) {
  const body = rec.request?.body ?? {};

  let systemChars = 0;
  for (const b of body.system ?? []) systemChars += String(b?.text ?? "").length;

  let toolsChars = 0;
  let nativeChars = 0;
  let nativeCount = 0;
  const mcp = new Map();
  for (const tool of body.tools ?? []) {
    const chars = JSON.stringify(tool).length;
    toolsChars += chars;
    const server = mcpServerOf(tool?.name ?? "");
    if (server) {
      let g = mcp.get(server);
      if (!g) {
        g = { server, tools: 0, chars: 0 };
        mcp.set(server, g);
      }
      g.tools++;
      g.chars += chars;
    } else {
      nativeChars += chars;
      nativeCount++;
    }
  }

  const usage = rec.response?.usage ?? {};
  return {
    requestId: rec.requestId ?? null,
    turnId: rec.turnId ?? null,
    at: num(rec.startedAt),
    model: rec.model?.modelId ?? body.model ?? null,
    querySource: rec.querySource ?? null,
    messagesKind: rec.request?.messagesKind ?? "unknown",
    messageCount: num(rec.request?.messageCount),
    loggedMessages: (rec.request?.messages ?? []).length,
    observedInputTokens: num(usage.inputTokens),
    observedCacheRead: num(usage.cacheReadTokens),
    systemChars,
    toolsChars,
    nativeChars,
    nativeCount,
    mcpChars: toolsChars - nativeChars,
    mcpCount: [...mcp.values()].reduce((a, g) => a + g.tools, 0),
    staticChars: systemChars + toolsChars,
    mcpServers: [...mcp.values()].sort((a, b) => b.chars - a.chars),
  };
}

// 占比只在工具 schema 这一类内部计算：同类内容的 token 密度相同，密度会约掉，
// 因此这些占比不依赖任何分词假设，是这里最可靠的输出。
function aggregateAll(perRequest) {
  const n = perRequest.length;
  const last = perRequest[n - 1];

  // 会话中途工具集可能变化，因此同时统计各请求出现过的服务器并集，供一致性告警使用
  const everSeen = new Set();
  for (const r of perRequest) for (const s of r.mcpServers) everSeen.add(s.server);

  const toolsChars = last?.toolsChars ?? 0;
  const servers = (last?.mcpServers ?? []).map((s) => ({
    ...s,
    shareOfToolSchemas: toolsChars > 0 ? s.chars / toolsChars : 0,
    shareOfStatic: last?.staticChars > 0 ? s.chars / last.staticChars : 0,
  }));

  return {
    requestCount: n,
    // 字符量取最后一条请求的值（静态部分应恒定，一致性由 checkConsistency 保证）
    systemChars: last?.systemChars ?? 0,
    toolsChars,
    nativeChars: last?.nativeChars ?? 0,
    mcpChars: last?.mcpChars ?? 0,
    nativeCount: last?.nativeCount ?? 0,
    mcpCount: last?.mcpCount ?? 0,
    staticChars: last?.staticChars ?? 0,
    servers,
    serverCount: everSeen.size,
    mcpShareOfToolSchemas: toolsChars > 0 ? (last?.mcpChars ?? 0) / toolsChars : 0,
    mcpShareOfStatic: last?.staticChars > 0 ? (last?.mcpChars ?? 0) / last.staticChars : 0,
    avgObservedInputTokens: perRequest.reduce((a, r) => a + r.observedInputTokens, 0) / n,
  };
}

// 静态部分在同一会话内应当恒定。任一维度波动都说明工具集变了（MCP 重连、插件启停），
// 这既是对分析的校验，本身也是有用的信号。
function checkConsistency(perRequest) {
  const systems = new Set(perRequest.map((r) => r.systemChars));
  const tools = new Set(perRequest.map((r) => r.toolsChars));
  return {
    systemCharsStable: systems.size === 1,
    toolsCharsStable: tools.size === 1,
    distinctSystemSizes: [...systems].sort((a, b) => a - b),
    distinctToolSizes: [...tools].sort((a, b) => a - b),
  };
}

function buildWarnings(perRequest) {
  const w = [];
  const kinds = new Set(perRequest.map((r) => r.messagesKind));
  if (kinds.has("delta") || kinds.has("tail")) w.push("messages-windowed-no-history-estimate");
  if (!checkConsistency(perRequest).toolsCharsStable) w.push("tool-set-changed-mid-session");
  return w;
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
