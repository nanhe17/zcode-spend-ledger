// 把结构化报告渲染成终端文本。
import { c, fmtTokens, fmtUsd, fmtPct, fmtMs, fmtBytes, table, heading, bullet, quoteLines } from "./render.mjs";
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

// ---- 上下文静态构成 ----

export function renderComposition(comp, t) {
  if (!comp?.ok) {
    const why =
      comp?.error === "model-io-not-found"
        ? "未找到该会话的 model-io 记录（可能已被清理，或该会话没有产生模型请求）"
        : comp?.error ?? "不可用";
    return heading("上下文静态构成", 2) + "\n" + c.dim("  " + why);
  }
  const a = comp.aggregate;
  const out = [heading("上下文静态构成", 2)];
  const span = comp.firstAt && comp.lastAt ? ` · ${new Date(comp.firstAt).toLocaleTimeString()}–${new Date(comp.lastAt).toLocaleTimeString()}` : "";
  out.push(c.dim(`  最近保留的 ${comp.requestCount} 条请求${span} · 平均输入 ${fmtTokens(a.avgObservedInputTokens)} token（实测）`));
  out.push(c.dim("  model-io 是滚动窗口，条数不等于会话请求总数；静态构成在同一会话内恒定，故不受窗口影响。"));
  out.push(
    c.dim(
      `  构成一致性：系统提示 ${comp.consistency.systemCharsStable ? "稳定" : "有变化"} · ` +
        `工具 schema ${comp.consistency.toolsCharsStable ? "稳定" : "有变化"}`
    )
  );

  out.push(
    table(
      [
        { header: "字符量（精确）", key: "k" },
        { header: "chars", key: "chars", align: "right", render: (v) => v.toLocaleString() },
        { header: "", key: "note" },
      ],
      [
        { k: "  系统提示", chars: a.systemChars, note: "" },
        { k: c.bold("  工具 schema"), chars: a.toolsChars, note: "" },
        { k: "    原生工具", chars: a.nativeChars, note: `${a.nativeCount} 个` },
        { k: "    MCP 工具", chars: a.mcpChars, note: `${a.mcpCount} 个 · 占工具定义 ${fmtPct(a.mcpShareOfToolSchemas)}` },
        { k: c.bold("  静态合计"), chars: a.staticChars, note: "" },
      ],
      { hideHeader: false }
    )
  );

  if (a.servers.length) {
    out.push(heading("按 MCP 服务器", 2));
    out.push(
      table(
        [
          { header: "server", key: "server" },
          { header: "tools", key: "tools", align: "right" },
          { header: "chars", key: "chars", align: "right", render: (v) => v.toLocaleString() },
          { header: "占工具定义", key: "shareOfToolSchemas", align: "right", render: (v) => fmtPct(v) },
          { header: "占静态", key: "shareOfStatic", align: "right", render: (v) => fmtPct(v) },
        ],
        a.servers
      )
    );
    out.push(c.dim("  占比在同一类内容内部计算，token 密度会约掉，因此不依赖任何分词假设。"));
  }

  for (const w of comp.warnings ?? []) out.push(bullet(c.yellow(warningText(w))));
  if (comp.authority?.note) out.push("\n" + c.dim(quoteLines(comp.authority.note, "  ")));
  return out.join("\n");
}

function warningText(code) {
  switch (code) {
    case "messages-windowed-no-history-estimate":
      return "该会话的 messages 是窗口记录（delta/tail），本模块因此不估算历史部分。";
    case "tool-set-changed-mid-session":
      return "工具 schema 的字符量在会话中途发生变化，说明工具集变了（MCP 重连或插件启停）。";
    default:
      return code;
  }
}

// ---- 建议 ----

const KIND_LABEL = {
  "tokens-fresh": "新增输入",
  "tokens-cached": "缓存读取",
  "chars-static": "常驻字符",
  none: "信息",
};

export function renderFindings(result, t, { limit = 8 } = {}) {
  if (!result?.ok) return c.yellow("建议不可用：缺少报告数据。");
  if (!result.findings.length) return heading("建议", 2) + "\n" + c.dim("  没有发现值得提示的浪费。");

  const s = result.estimatedSaving;
  const out = [heading("建议", 2)];
  const bits = [];
  if (s.freshTokens) bits.push(`新增输入 ${fmtTokens(s.freshTokens)} token ≈ ${fmtUsd(s.freshTokens * result.rates.fresh)}`);
  if (s.cachedTokens) bits.push(`缓存读取 ${fmtTokens(s.cachedTokens)} token ≈ ${fmtUsd(s.cachedTokens * result.rates.cacheRead)}`);
  if (s.staticChars) bits.push(`常驻字符 ${fmtTokens(s.staticChars)}（不折算金额）`);
  out.push(c.dim("  可省合计：" + (bits.join(" · ") || "无")));
  out.push(
    c.dim(
      `  单价来自你自己的实测数据：新增输入 ${result.rates.fresh.toExponential(2)} 美元/token · ` +
        `缓存读取 ${result.rates.cacheRead.toExponential(2)} 美元/token（相差 ${(result.rates.fresh / Math.max(result.rates.cacheRead, 1e-12)).toFixed(0)} 倍）`
    )
  );

  for (const f of result.findings.slice(0, limit)) {
    const tag = f.severity === "high" ? c.red("high") : f.severity === "medium" ? c.yellow("medium") : c.dim("low");
    out.push("");
    out.push(`  [${tag}] ${c.bold(f.title)}`);
    const amt = [];
    if (f.savingTokens) amt.push(`${fmtTokens(f.savingTokens)} token`);
    if (f.savingChars) amt.push(`${f.savingChars.toLocaleString()} 字符`);
    if (f.savingUsd) amt.push(`≈ ${fmtUsd(f.savingUsd)}`);
    if (amt.length) out.push(c.dim(`         可省 ${amt.join(" · ")}  [${KIND_LABEL[f.savingKind] ?? f.savingKind}]`));
    out.push(dimEvidence(f.evidence));
    out.push(c.dim("         → ") + f.recommendation);
    if (f.basis) out.push(c.dim("         口径 " + f.basis));
  }
  out.push("");
  out.push(c.dim("  可省量基于已发生的开销推算，是估算而非测量。常驻缓存的静态内容不折算金额，"));
  out.push(c.dim("  因为它的边际成本约为新增输入的 1/41，折算成美元会严重高估。"));
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
