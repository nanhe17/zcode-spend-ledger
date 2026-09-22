// 把结构化报告渲染成终端文本。
import { c, fmtTokens, fmtUsd, fmtPct, fmtMs, fmtBytes, table, heading, bullet } from "./render.mjs";
import { mcpServerOf } from "./attribution.mjs";

export function renderReport(rep, t) {
  if (!rep.ok) {
    const lines = [c.red(t("error.no_db", { path: rep.path }))];
    if (rep.detail) lines.push(c.dim(String(rep.detail)));
    if (rep.hint) lines.push(c.yellow(String(rep.hint)));
    return lines.join("\n");
  }
  const out = [];
  out.push(heading(t("report.title")));

  const scopeBits = [];
  if (rep.scope.kind === "session") scopeBits.push(`${t("report.scope.session")}${rep.scope.sessionId ? " " + rep.scope.sessionId : ""}`);
  if (rep.scope.kind === "workspace") scopeBits.push(`${t("report.scope.workspace")} ${rep.scope.workspace ?? ""}`);
  if (rep.scope.kind === "all") scopeBits.push(t("report.scope.all"));
  if (rep.scope.since) scopeBits.push(`${t("label.period")} ≥ ${new Date(rep.scope.since).toLocaleString()}`);
  if (rep.fallback) scopeBits.push(c.yellow("当前目录没有会话记录，已改用全部数据"));
  if (rep.scope.fallbackReason === "no-session-resolved-for-cwd") {
    scopeBits.push(c.yellow("未解析到具体会话，统计的是全部数据"));
  }
  out.push(c.dim(scopeBits.join("  ·  ")));
  if (rep.scope.sessionCount > 1 && rep.scope.kind !== "session") {
    out.push(c.dim(`${t("label.session")} 数: ${rep.scope.sessionCount}（含副代理会话）`));
  }
  if (rep.scope.sessions?.length && rep.scope.kind === "session") {
    const s = rep.scope.sessions.find((x) => x.id === rep.scope.sessionId);
    if (s?.title) out.push(c.dim(`${t("label.session")}: ${truncate(s.title, 90)}`));
  }
  if (rep.warning) out.push(c.yellow(`⚠ ${rep.warning}`));

  const t0 = rep.totals;
  if (t0.requests === 0) {
    out.push("\n" + c.yellow(t("error.no_rows")));
    return out.join("\n");
  }

  out.push(heading(t("report.total"), 2));
  out.push(
    table(
      [
        { header: "", key: "label" },
        { header: "", key: "value", align: "right" },
      ],
      [
        { label: t("report.requests"), value: String(t0.requests) },
        { label: t("report.fresh_input"), value: fmtTokens(t0.fresh) },
        { label: t("report.cache_read"), value: `${fmtTokens(t0.cacheRead)}  ${c.dim("(" + fmtPct(t0.cacheReadShare) + ")")}` },
        ...(t0.cacheWrite ? [{ label: t("report.cache_write"), value: fmtTokens(t0.cacheWrite) }] : []),
        { label: t("report.output"), value: fmtTokens(t0.output) },
        { label: t("report.cost"), value: c.bold(fmtUsd(t0.cost)) + (t0.unpricedRequests ? c.yellow(`  (+${t0.unpricedRequests} ${t("doctor.unpriced")})`) : "") },
        ...(t0.avgFirstTokenMs ? [{ label: "avg TTFT", value: fmtMs(t0.avgFirstTokenMs) }] : []),
      ],
      { hideHeader: true }
    )
  );

  out.push(heading(t("report.by_query_source"), 2));
  out.push(dimTable(rep.dimensions.querySource, t));

  if (rep.dimensions.agent.length > 1) {
    out.push(heading(t("report.by_agent"), 2));
    out.push(dimTable(rep.dimensions.agent, t));
  }
  if (rep.dimensions.mode.length > 1) {
    out.push(heading(t("report.by_mode"), 2));
    out.push(dimTable(rep.dimensions.mode, t));
  }

  out.push(heading(t("report.by_model"), 2));
  out.push(dimTable(rep.dimensions.model, t));

  if (rep.attribution.tools.length) {
    out.push(heading(t("report.by_tool"), 2));
    out.push(
      table(
        [
          { header: "tool", key: "key" },
          { header: t("unit.tokens"), key: "tokens", align: "right", render: fmtTokens },
          { header: t("label.share"), key: "share", align: "right", render: (v) => fmtPct(v) },
          { header: t("report.cost"), key: "cost", align: "right", render: fmtUsd },
          { header: "calls", key: "calls", align: "right" },
        ],
        rep.attribution.tools.slice(0, 12)
      )
    );
  }

  if (rep.attribution.files.length) {
    out.push(heading("Top files", 2));
    out.push(
      table(
        [
          { header: "file", key: "key", render: (v) => truncate(shortPath(v), 72) },
          { header: t("unit.tokens"), key: "tokens", align: "right", render: fmtTokens },
          { header: t("label.share"), key: "share", align: "right", render: (v) => fmtPct(v) },
          { header: "calls", key: "calls", align: "right" },
        ],
        rep.attribution.files.slice(0, 10)
      )
    );
  }

  if (rep.mcpServers.length) {
    out.push(heading("MCP", 2));
    out.push(
      table(
        [
          { header: "server", key: "server" },
          { header: "calls", key: "calls", align: "right" },
          { header: "tools", key: "toolCount", align: "right" },
          { header: "output", key: "outputBytes", align: "right", render: fmtBytes },
        ],
        rep.mcpServers
      )
    );
  }

  out.push(heading(t("report.notes"), 2));
  for (const note of rep.notes) out.push(bullet(noteText(note, t)));

  return out.join("\n");
}

function dimTable(rows, t) {
  return table(
    [
      { header: "key", key: "key" },
      { header: t("report.requests"), key: "requests", align: "right" },
      { header: "input", key: "input", align: "right", render: fmtTokens },
      { header: "output", key: "output", align: "right", render: fmtTokens },
      { header: t("report.cost"), key: "cost", align: "right", render: fmtUsd },
      { header: t("label.share"), key: "shareInput", align: "right", render: (v) => fmtPct(v) },
    ],
    rows
  );
}

function noteText(note, t) {
  switch (note.code) {
    case "cache-inclusive":
      return t("note.cache_inclusive");
    case "cache-share":
      return t("note.cache_share", { pct: note.pct, factor: note.factor });
    case "unpriced":
      return t("note.unpriced", { count: note.count, models: note.models.join(", ") }) + `  (${fmtTokens(note.tokens)} tokens)`;
    case "cache-write-assumed":
      return t("note.cache_write_assumed", { mult: 1.25, tokens: fmtTokens(note.tokens) }) + `  [${note.models.join(", ")}]`;
    case "cache-write-zero":
      return t("note.cache_write_zero");
    case "coverage":
      return (
        t("note.coverage", { pct: note.pct }) +
        c.dim(
          `  [attributed ${fmtTokens(note.attributed)} · assistant ${fmtTokens(note.assistantCarry)} · residual ${fmtTokens(note.residual)}` +
            (note.shrinkCount ? ` · shrink ${fmtTokens(note.shrinkTokens)}/${note.shrinkCount}×` : "") +
            "]"
        )
      );
    default:
      return note.code;
  }
}

export function shortPath(p) {
  if (!p) return "";
  const parts = String(p).split(/[\\/]/);
  return parts.length <= 3 ? p : "…" + parts.slice(-3).join("/");
}

export function truncate(s, n) {
  const str = String(s ?? "").replace(/\s+/g, " ");
  return str.length <= n ? str : str.slice(0, n - 1) + "…";
}

// ---- 上下文成分 ----

export function renderComposition(comp, t) {
  if (!comp?.ok) {
    const why = comp?.error === "model-io-not-found"
      ? "未找到该会话的 model-io 记录（可能已被清理，或该会话没有产生模型请求）"
      : comp?.error ?? "不可用";
    return heading("上下文成分", 2) + "\n" + c.dim("  " + why);
  }
  const a = comp.aggregate;
  const out = [heading("上下文成分", 2)];
  out.push(
    c.dim(
      `  ${comp.requestCount} 个请求 · 平均输入 ${fmtTokens(a.avgInputTokens)} · ` +
        `标定 ${comp.calibration.source}${comp.calibration.samples ? ` (${comp.calibration.samples} 条 full 记录, 密度 ${comp.calibration.density.toFixed(3)})` : ""}`
    )
  );

  out.push(
    table(
      [
        { header: "", key: "k" },
        { header: "per request", key: "per", align: "right", render: fmtTokens },
        { header: "share", key: "share", align: "right", render: (v) => (v == null ? "" : fmtPct(v)) },
        { header: "session total", key: "total", align: "right", render: fmtTokens },
      ],
      [
        { k: c.bold("每轮固定开销"), per: a.staticPerRequest, share: a.staticShare, total: a.staticTokens },
        { k: "  系统提示", per: a.systemPerRequest, share: null, total: a.systemTokens },
        { k: "  工具 schema", per: a.toolSchemaPerRequest, share: null, total: a.toolsTokens },
        { k: "    原生工具", per: a.nativeToolPerRequest, share: null, total: a.nativeToolTokens },
        { k: "    MCP 工具", per: a.mcpPerRequest, share: null, total: a.mcpTokens },
        { k: "历史与其余", per: a.historyPerRequest, share: a.historyShare, total: a.historyTokens },
      ],
      { hideHeader: false }
    )
  );
  out.push(c.dim("  注：历史量由「实测输入 − 静态」得出，因此自动包含未被记录的消息与未建模字段。"));

  if (a.mcpServers.length) {
    out.push(heading("MCP 每轮固定开销", 2));
    out.push(
      table(
        [
          { header: "server", key: "server" },
          { header: "tools", key: "tools", align: "right" },
          { header: "per request", key: "perRequestTokens", align: "right", render: fmtTokens },
          { header: "session total", key: "totalTokens", align: "right", render: fmtTokens },
        ],
        a.mcpServers
      )
    );
  }

  if (a.historyBreakdown) {
    const h = a.historyBreakdown.perRequest;
    out.push(heading(`历史细分（仅 full 记录, n=${a.historyBreakdown.samples}）`, 2));
    out.push(
      table(
        [
          { header: "role", key: "role" },
          { header: "per request", key: "v", align: "right", render: fmtTokens },
        ],
        Object.entries(h)
          .filter(([, v]) => v > 0)
          .sort((x, y) => y[1] - x[1])
          .map(([role, v]) => ({ role, v }))
      )
    );
  }

  if (comp.warnings?.length) {
    for (const w of comp.warnings) out.push(bullet(c.yellow(warningText(w))));
  }
  return out.join("\n");
}

function warningText(code) {
  switch (code) {
    case "no-full-records-for-calibration":
      return "没有可用于标定的完整记录，已使用默认密度，绝对值误差可能较大。";
    case "static-overhead-changed-mid-session":
      return "静态开销在会话中途发生变化，说明工具集变了（MCP 重连或插件启停）。";
    case "messages-windowed-history-is-residual":
      return "该会话的 messages 是窗口记录（delta/tail），历史量按残差计算。";
    case "static-exceeds-observed":
      return "静态估算超过实测输入，标定可能失真，请以 doctor 检查数据源。";
    default:
      return code;
  }
}

// ---- 建议 ----

export function renderFindings(result, t, { limit = 8 } = {}) {
  if (!result?.ok) return c.yellow("建议不可用：缺少报告数据。");
  if (!result.findings.length) return heading("建议", 2) + "\n" + c.dim("  本会话没有发现值得提示的浪费。");
  const out = [heading("建议", 2)];
  out.push(
    c.dim(`  合计可省估算 ${fmtTokens(result.estimatedSavingTokens)} token` + (result.rate ? `（按新增输入单价 ≈ ${fmtUsd(result.estimatedSavingTokens * result.rate)}）` : ""))
  );
  for (const f of result.findings.slice(0, limit)) {
    const tag = f.severity === "high" ? c.red("high") : f.severity === "medium" ? c.yellow("medium") : c.dim("low");
    out.push("");
    out.push(`  [${tag}] ${c.bold(f.title)}`);
    if (f.savingTokens > 0) out.push(c.dim(`         可省估算 ${fmtTokens(f.savingTokens)} token`));
    out.push(dimEvidence(f.evidence));
    out.push(c.dim("         → ") + f.recommendation);
  }
  out.push("");
  out.push(c.dim("  可省估算基于已发生的开销推算，是估算值而非测量值。"));
  return out.join("\n");
}

function dimEvidence(evidence) {
  const parts = [];
  for (const [k, v] of Object.entries(evidence ?? {})) {
    if (Array.isArray(v)) {
      parts.push(`${k}: ${v.map((x) => (typeof x === "object" ? JSON.stringify(x) : x)).join(", ")}`);
    } else if (v != null && v !== false) {
      parts.push(`${k}: ${v}`);
    }
  }
  return c.dim("         证据 " + truncate(parts.join(" · "), 150));
}

export { mcpServerOf };
