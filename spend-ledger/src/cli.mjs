// CLI 入口。命令与 MCP 工具都调用同一套 core。
//
// 子命令：
//   report    用量与成本报告（默认）
//   doctor    自检：数据源、定价覆盖、账本、运行时
//   sessions  列出范围内的会话
//   why       查看账本中记录的建议及其证据
//
// 常用参数：--scope session|workspace|all  --session <id>  --since 7d  --json  --no-color
import { existsSync, readdirSync } from "node:fs";
import { zcodePaths, dataDir, snapshotPath, overridePath, describeSources } from "./paths.mjs";
import { openUsageDb, loadProviderCatalog, providerSlug, readSettings, findSessions, loadSqlite, SQLITE_UNAVAILABLE_HINT } from "./db.mjs";
import { loadSnapshot, loadOverrides, createPricer } from "./pricing.mjs";
import { buildReport, pickCompositionSession } from "./report.mjs";
import { renderReport, renderComposition, renderFindings } from "./view.mjs";
import { analyzeComposition } from "./composition.mjs";
import { advise } from "./advisor.mjs";
import { ledgerStatus, openLedger, LEDGER_VERSION } from "./ledger.mjs";
import { detectLocale, createTranslator } from "./i18n.mjs";
import { c, fmtTokens, fmtUsd, heading, table } from "./render.mjs";

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=");
      const key = k.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      if (inline != null) args[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) args[key] = argv[++i];
      else args[key] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const command = args._[0] ?? "report";
  const settings = readSettings(env);
  const locale = args.locale ?? detectLocale(env, settings);
  const t = createTranslator(locale);

  switch (command) {
    case "report":
      return cmdReport(args, env, t);
    case "advise":
      return cmdAdvise(args, env, t);
    case "composition":
      return cmdComposition(args, env, t);
    case "doctor":
      return cmdDoctor(args, env, t);
    case "sessions":
      return cmdSessions(args, env, t);
    case "why":
      return cmdWhy(args, env, t);
    case "help":
    case "--help":
      return helpText();
    default:
      return `未知命令：${command}\n\n` + helpText();
  }
}

function helpText() {
  return [
    "spend-ledger — ZCode 用量与成本归因",
    "",
    "  report       [--scope session|workspace|all] [--session <id>] [--since 7d] [--composition] [--json]",
    "  advise       给出可执行建议（含每轮固定开销与可省估算）[--json]",
    "  composition   只输出上下文成分（系统提示 / 工具 schema / 各 MCP 服务器）[--json]",
    "  doctor       自检数据源、定价覆盖、账本与运行时",
    "  sessions     列出范围内的会话",
    "  why          查看账本中记录的建议与证据",
    "",
  ].join("\n");
}

function scopeArgs(args, env) {
  return {
    scope: args.scope ?? "session",
    sessionId: args.session,
    workspace: args.workspace ?? env.ZCODE_PROJECT_DIR ?? process.cwd(),
    since: args.since,
    until: args.until,
    env,
  };
}

async function cmdReport(args, env, t) {
  let rep = buildReport(scopeArgs(args, env));

  // 会话范围内没命中时（例如命令在不相关的目录执行），退化为全量并明确提示
  if (rep.ok && rep.totals.requests === 0 && args.scope !== "all") {
    const retry = buildReport({ ...scopeArgs(args, env), scope: "all", workspace: undefined });
    if (retry.ok && retry.totals.requests > 0) {
      retry.notes.push({ code: "fell-back-to-all" });
      retry.fallback = true;
      rep = retry;
    }
  }

  let comp = null;
  if (rep.ok && args.composition) comp = await compositionFor(rep, args, env);

  if (args.json) return JSON.stringify({ ...toJson(rep), ...(comp ? { composition: comp } : {}) }, null, 2);
  return renderReport(rep, t) + (comp ? "\n" + renderComposition(comp, t) : "");
}

async function cmdComposition(args, env, t) {
  const rep = buildReport(scopeArgs(args, env));
  if (!rep.ok) return c.red(t("error.no_db", { path: rep.path }));
  const comp = await compositionFor(rep, args, env);
  if (args.json) return JSON.stringify(comp, null, 2);
  return renderComposition(comp, t);
}

async function cmdAdvise(args, env, t) {
  const rep = buildReport(scopeArgs(args, env));
  if (!rep.ok) return c.red(t("error.no_db", { path: rep.path }));
  const comp = await compositionFor(rep, args, env);
  const result = advise(rep, comp);

  // 落账本，供 why 与去重使用；账本不可用不应影响主流程
  try {
    const l = openLedger(env);
    l.recordFindings(
      result.findings.map((f) => ({ id: f.id, rule: f.rule, severity: f.severity, evidence: f.evidence, savingTokens: f.savingTokens }))
    );
    l.recordReportRun({
      scope: rep.scope.kind,
      sessionId: rep.scope.sessionId,
      costUsd: rep.totals.cost,
      inputTokens: rep.totals.input,
      outputTokens: rep.totals.output,
    });
    l.close();
  } catch {
    /* 账本是增强项，失败不阻塞 */
  }

  if (args.json) return JSON.stringify({ advice: result, composition: comp, scope: rep.scope, totals: rep.totals }, null, 2);
  return renderComposition(comp, t) + "\n" + renderFindings(result, t);
}

// 成分分析需要单个会话；范围里没有明确会话时取范围内最新的主会话（跳过副代理）
async function compositionFor(rep, args, env) {
  const sid = pickCompositionSession(rep);
  if (!sid) return { ok: false, error: "no-session-in-scope" };
  return analyzeComposition({ sessionId: sid, env, maxRequests: args.maxRequests ?? 0, includeText: Boolean(args.includeText) });
}

function toJson(rep) {
  if (!rep.ok) return rep;
  const { requests, ...rest } = rep;
  return rest;
}

function cmdSessions(args, env, t) {
  const conn = openUsageDb({ env });
  if (!conn.ok) return c.red(t("error.no_db", { path: conn.path }));
  try {
    const rows = findSessions(conn, {
      workspace: args.all ? undefined : (args.workspace ?? env.ZCODE_PROJECT_DIR ?? process.cwd()),
      includeSubagents: Boolean(args.subagents),
      limit: args.limit ?? 40,
    });
    if (!rows.length) return c.yellow(t("error.no_sessions", { scope: args.workspace ?? process.cwd() }));
    const out = [heading("Sessions")];
    out.push(
      table(
        [
          { header: "session", key: "id" },
          { header: "title", key: "title", render: (v) => String(v ?? "").replace(/\s+/g, " ").slice(0, 52) },
          { header: "workspace", key: "directory", render: (v) => String(v ?? "").split(/[\\/]/).slice(-1)[0] },
          { header: "created", key: "time_created", render: (v) => new Date(v).toLocaleString() },
        ],
        rows
      )
    );
    return args.json ? JSON.stringify(rows, null, 2) : out.join("\n");
  } finally {
    conn.close();
  }
}

function cmdWhy(args, env, t) {
  const ledger = openLedger(env);
  try {
    const findings = ledger.listFindings({ includeDismissed: Boolean(args.all) });
    if (!findings.length) {
      return "账本中暂无建议记录。建议由 advisor 规则产生，将在后续版本提供。";
    }
    const out = [heading("Findings")];
    out.push(
      table(
        [
          { header: "rule", key: "rule" },
          { header: "severity", key: "severity" },
          { header: "saving", key: "saving_tokens", align: "right", render: fmtTokens },
          { header: "seen", key: "occurrences", align: "right" },
          { header: "evidence", key: "evidence", render: (v) => String(v).slice(0, 80) },
        ],
        findings
      )
    );
    return args.json ? JSON.stringify(findings, null, 2) : out.join("\n");
  } finally {
    ledger.close();
  }
}

export function runDoctor(env = process.env) {
  const p = zcodePaths(env);
  const settings = readSettings(env);
  const catalog = loadProviderCatalog(env);
  const snapshot = loadSnapshot(snapshotPath(env));
  const overrides = loadOverrides(overridePath(env));
  const pricer = createPricer({ snapshot, overrides });
  const ledger = ledgerStatus(env);
  const conn = openUsageDb({ env });

  const checks = [];
  // id 是稳定的机器可读标识（供 --json 与测试使用），展示标签由渲染层本地化
  const add = (id, status, detail) => checks.push({ id, status, detail });
  const usedUnpriced = [];

  add("node", loadSqlite() ? "ok" : "fail", loadSqlite()
    ? `${process.version} · sqlite ${process.versions.sqlite ?? "n/a"}`
    : `${process.version} · ${SQLITE_UNAVAILABLE_HINT}`);
  add("data-dir", "ok", dataDir(env));

  if (conn.ok) {
    const meta = conn.meta();
    add("usage-db", "ok", `${meta.path} · ${(conn.bytes / 1048576).toFixed(1)}MB · journal=${meta.journal}`);
    add("open-mode", conn.degraded ? "warn" : "ok", conn.mode + (conn.degraded ? "  (降级：仍可读，但建议确认原因)" : ""));
    add("json1", meta.json1 ? "ok" : "fail", meta.json1 ? "可用" : "不可用（文件路径归因会缺失）");
    // 实际用过、但定价表解析不到的模型：比只看配置声明更能反映真实缺口
    try {
      for (const r of conn.db.prepare("select model_id, provider_id, count(*) c from model_usage group by 1,2").all()) {
        if (!pricer.rateFor(r.model_id, providerSlug(r.provider_id, catalog))) usedUnpriced.push(`${r.model_id} ×${r.c}`);
      }
    } catch {
      /* 表不存在时忽略 */
    }
    conn.close();
  } else {
    add("usage-db", "fail", `${conn.path} · ${conn.error}`);
  }

  add("tasks-index", existsSync(p.tasksIndex) ? "ok" : "warn", p.tasksIndex);
  add("ledger", ledger.sqliteAvailable ? "ok" : "warn", `${ledger.kind} · ${ledger.path} · schema v${LEDGER_VERSION}`);

  if (snapshot.missing) {
    add("pricing-snapshot", "fail", `缺失：${snapshotPath(env)}`);
  } else {
    const ageDays = snapshot.generatedAt ? ((Date.now() - Date.parse(snapshot.generatedAt)) / 86400000).toFixed(1) : "?";
    add("pricing-snapshot", pricer.isSnapshotStale() ? "warn" : "ok", `${Object.keys(snapshot.models).length} 个模型 · 生成于 ${ageDays} 天前 · 剔除全零条目 ${snapshot.rejected?.length ?? 0}`);
  }

  // 配置里声明、但定价表解析不到的模型 —— 这是最常见的手工修复点
  const unpricedConfigured = [];
  for (const m of catalog.models) {
    if (!pricer.rateFor(m.modelId, m.slug)) unpricedConfigured.push(`${m.modelId} (${m.providerLabel})`);
  }
  const gaps = [...new Set([...usedUnpriced, ...unpricedConfigured])];
  add(
    "unpriced-models",
    gaps.length ? "warn" : "ok",
    gaps.length ? `${gaps.length} 个模型无定价，将单列而不计入费用：${gaps.slice(0, 6).join(", ")}` : "全部可计价"
  );

  const ioFiles = listModelIo(p);
  const retention = settings.modelIoFullRetentionEnabled === true;
  add(
    "model-io",
    ioFiles.length ? (retention ? "ok" : "warn") : "warn",
    ioFiles.length
      ? `${ioFiles.length} 个文件 · 全量保留=${retention} · 该文件是滚动窗口（按体积截断，只保留最近请求）`
      : "未找到 model-io 记录（静态上下文测量不可用）"
  );

  return { checks, sources: describeSources(env) };
}

function listModelIo(p) {
  try {
    if (!existsSync(p.rolloutDir)) return [];
    return readdirSync(p.rolloutDir).filter((f) => f.startsWith("model-io-"));
  } catch {
    return [];
  }
}

function cmdDoctor(args, env, t) {
  const { checks } = runDoctor(env);
  // JSON 保留稳定的机器可读 id；终端展示走本地化标签，标签缺失时回退到 id。
  // 状态文案同样本地化，避免英文用户看到中文状态。
  if (args.json) return JSON.stringify({ checks }, null, 2);
  const label = (c) => {
    const key = `check.${c.id}`;
    const translated = t(key);
    return translated === key ? c.id : translated;
  };
  const status = (v) => {
    const key = v === "ok" ? "doctor.ok" : v === "warn" ? "doctor.warn" : "doctor.fail";
    const text = t(key);
    return v === "ok" ? c.green(text) : v === "warn" ? c.yellow(text) : c.red(text);
  };
  const out = [heading(t("doctor.title"))];
  out.push(
    table(
      [
        { header: t("doctor.col.check"), key: "id", render: (_, row) => label(row) },
        { header: t("doctor.col.status"), key: "status", render: status },
        { header: t("doctor.col.detail"), key: "detail" },
      ],
      checks
    )
  );
  return out.join("\n");
}

// 允许被 MCP 服务与测试复用
export { buildReport, renderReport };
