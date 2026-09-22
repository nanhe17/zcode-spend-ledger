// 报告编排：打开只读库 → 取数 → 定价 → 归因 → 组装结构化结果。
// 结构化结果与渲染分离，MCP 服务可以直接返回 JSON。
import { openUsageDb, loadProviderCatalog, providerSlug, readSettings, findSessions, latestSession, usageRows, turnRows, toolRows, toolDetails } from "./db.mjs";
import { zcodePaths, snapshotPath, overridePath } from "./paths.mjs";
import { loadSnapshot, loadOverrides, createPricer, priceRows } from "./pricing.mjs";
import { summarize, rollupBy, attributeIncrementally, rollupMcpServers, rollupToolsByBytes } from "./attribution.mjs";

export function parseSince(value, now = Date.now()) {
  if (value == null || value === "") return null;
  // 数字一律按毫秒时间戳处理。若先转成字符串再走 Date.parse，
  // 像 4000 这样的毫秒值会被当成公元 4000 年，静默过滤掉全部数据。
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  const rel = /^(\d+)\s*(m|h|d|w)$/i.exec(s);
  if (rel) {
    const mult = { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[rel[2].toLowerCase()];
    return now - Number(rel[1]) * mult;
  }
  if (/^\d{11,}$/.test(s)) return Number(s); // 字符串形式的毫秒时间戳
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveScope({ scope = "session", sessionId, workspace, since, until, env = process.env, conn }) {
  const filter = { sessionId: null, workspace: null, since: parseSince(since), until: parseSince(until) };
  if (scope === "session") {
    const id = sessionId || env.ZCODE_SESSION_ID || null;
    if (id) {
      filter.sessionId = id;
    } else {
      // 命令执行时页面并不知道会话 id，因此退回「当前工作区最近一个会话」
      const s = latestSession(conn, { workspace });
      if (s) filter.sessionId = s.id;
    }
  } else if (scope === "workspace") {
    filter.workspace = workspace ?? null;
  }
  return filter;
}

export function buildReport(opts = {}) {
  const env = opts.env ?? process.env;
  const settings = readSettings(env);
  const catalog = loadProviderCatalog(env);
  const p = zcodePaths(env);

  const snapshot = loadSnapshot(opts.snapshotPath ?? snapshotPath(env));
  const overrides = loadOverrides(opts.overridePath ?? overridePath(env));
  const pricer = createPricer({ snapshot, overrides });

  const conn = opts.conn ?? openUsageDb({ env });
  if (!conn.ok) {
    return { ok: false, error: "db-unavailable", detail: conn.error, hint: conn.hint ?? null, path: conn.path, settings, catalog };
  }
  const ownsConn = !opts.conn;

  try {
    const filter = resolveScope({ ...opts, env, conn });
    const sessions = findSessions(conn, {
      sessionId: filter.sessionId,
      workspace: filter.workspace,
      since: filter.since,
      until: filter.until,
      includeSubagents: true,
      limit: 5000,
    });
    const sessionIds = sessions.map((s) => s.id);
    const dataFilter = { ...filter, sessionIds: sessionIds.length ? sessionIds : undefined };

    // 作用域诚实性：请求了「本次会话」但没解析出具体会话时，
    // 实际统计的是全部数据，标签必须如实反映，否则读者会误判范围。
    const requestedKind = opts.scope ?? "session";
    const unresolvable = requestedKind === "session" && !filter.sessionId;
    const effectiveKind = unresolvable ? "all" : requestedKind;

    const rows = usageRows(conn, dataFilter);
    const turns = turnRows(conn, dataFilter);
    const tools = toolRows(conn, dataFilter);
    const details = toolDetails(conn, dataFilter);

    const providerNameFor = (row) => providerSlug(row.provider_id, catalog);
    const pricedResult = priceRows(rows, pricer, providerNameFor);
    const priced = pricedResult.rows;
    const totals = summarize(priced);

    const detailsByCall = new Map();
    for (const d of details) if (d.tool_call_id) detailsByCall.set(d.tool_call_id, d);

    const attribution = attributeIncrementally(priced, tools, {
      rateForRow: (row) => pricer.inputRateFor(row.model_id, providerSlug(row.provider_id, catalog), row.input_tokens),
      detailsByCall,
    });

    const dimensions = {
      querySource: rollupBy(priced, (r) => r.query_source, "key"),
      agent: rollupBy(priced, (r) => r.agent, "key"),
      mode: rollupBy(priced, (r) => r.mode, "key"),
      model: rollupBy(priced, (r) => r.model_id, "key"),
      provider: rollupBy(priced, (r) => r.provider_id, "key"),
      variant: rollupBy(priced, (r) => r.variant, "key"),
      session: rollupBy(priced, (r) => r.session_id, "key"),
    };

    const notes = buildNotes({ totals, pricer, priced, attribution });

    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      scope: {
        kind: effectiveKind,
        requestedKind,
        sessionId: filter.sessionId,
        workspace: filter.workspace,
        since: filter.since,
        until: filter.until,
        sessionCount: sessions.length,
        fallbackReason: unresolvable ? "no-session-resolved-for-cwd" : null,
        sessions,
      },
      db: conn.meta(),
      snapshot: { generatedAt: snapshot.generatedAt, models: Object.keys(snapshot.models).length, missing: snapshot.missing },
      totals,
      dimensions,
      attribution,
      toolsByBytes: rollupToolsByBytes(tools),
      mcpServers: rollupMcpServers(priced, tools),
      turnStats: summarizeTurns(turns),
      requests: priced,
      notes,
      warning: conn.degraded
        ? conn.mode === "immutable"
          ? "immutable-mode-may-show-stale-data"
          : "snapshot-copy-mode"
        : null,
    };
  } finally {
    if (ownsConn) conn.close();
  }
}

function summarizeTurns(turns) {
  const t = { turns: turns.length, modelRequests: 0, toolCalls: 0, toolErrors: 0, retries: 0, contextExceeded: 0, durationMs: 0, cancelled: 0 };
  for (const r of turns) {
    t.modelRequests += r.model_request_count ?? 0;
    t.toolCalls += r.tool_call_count ?? 0;
    t.toolErrors += r.tool_error_count ?? 0;
    t.retries += r.model_retry_count ?? 0;
    t.durationMs += r.duration_ms ?? 0;
    if (r.context_exceeded) t.contextExceeded++;
    if (r.cancelled_by_user) t.cancelled++;
  }
  return t;
}

function buildNotes({ totals, pricer, priced, attribution }) {
  const notes = [];
  notes.push({ code: "cache-inclusive" });

  if (totals.input > 0 && totals.cacheRead > 0) {
    const share = totals.cacheRead / totals.input;
    notes.push({
      code: "cache-share",
      pct: (share * 100).toFixed(1),
      factor: (1 / Math.max(1e-9, 1 - share)).toFixed(1),
    });
  }

  const unpriced = [...new Set(priced.filter((x) => !x.price.priced).map((x) => x.row.model_id))];
  if (unpriced.length) {
    notes.push({
      code: "unpriced",
      count: unpriced.length,
      models: unpriced,
      tokens: priced.filter((x) => !x.price.priced).reduce((a, x) => a + (x.row.input_tokens ?? 0) + (x.row.output_tokens ?? 0), 0),
    });
  }

  if (pricer.stats.assumedCacheWriteTokens > 0) {
    notes.push({
      code: "cache-write-assumed",
      tokens: pricer.stats.assumedCacheWriteTokens,
      models: [...pricer.stats.assumedCacheWriteModels],
    });
  } else if (totals.cacheWrite === 0 && totals.input > 0) {
    notes.push({ code: "cache-write-zero" });
  }

  if (attribution.growth > 0) {
    notes.push({
      code: "coverage",
      pct: (attribution.coverage * 100).toFixed(1),
      growth: attribution.growth,
      attributed: attribution.attributed,
      assistantCarry: attribution.assistantCarry,
      residual: attribution.residual,
      shrinkTokens: attribution.shrinkTokens,
      shrinkCount: attribution.shrinkEvents.length,
    });
  }

  return notes;
}
