// 文案与本地化。默认跟随 ZCode 的 v2/setting.json 的 locale，其次跟随环境变量。
export const DICTS = {
  "zh-CN": {
    "unit.tokens": "token",
    "unit.turns": "轮",
    "unit.requests": "次请求",
    "report.title": "用量与成本报告",
    "report.scope": "范围",
    "report.scope.session": "本次会话",
    "report.scope.workspace": "工作区",
    "report.scope.all": "全部",
    "report.total": "总计",
    "report.fresh_input": "新增输入",
    "report.cache_read": "缓存读取",
    "report.cache_write": "缓存写入",
    "report.output": "输出",
    "report.cost": "费用",
    "report.requests": "请求数",
    "report.by_query_source": "按请求来源",
    "report.by_agent": "按代理",
    "report.by_mode": "按模式",
    "report.by_model": "按模型",
    "report.by_tool": "按工具（token 归因）",
    "report.notes": "说明",
    "note.cache_inclusive": "input_tokens 已包含缓存读取与缓存写入，报告中的「新增输入」为扣除后的净值。",
    "note.cache_share": "缓存读取占总输入 {pct}%，若直接按输入单价计价会高估约 {factor} 倍。",
    "note.unpriced": "有 {count} 个模型无定价，其 token 未计入费用：{models}",
    "note.cache_write_assumed": "缓存写入单价在上游缺失，按输入单价的 {mult}× 估算，涉及 {tokens} token。",
    "note.coverage": "归因覆盖率 {pct}%（已归因增量 / 总增量）。",
    "note.cache_write_zero": "本次数据中缓存写入为 0 token，故缓存写入定价假设不影响结果。",
    "doctor.title": "自检",
    "doctor.db": "用量库",
    "doctor.open_mode": "只读打开方式",
    "doctor.index": "会话索引",
    "doctor.node": "Node 版本",
    "doctor.sqlite": "内置 SQLite",
    "doctor.snapshot": "定价快照",
    "doctor.snapshot_age": "快照生成于 {days} 天前",
    "doctor.unpriced": "未定价模型",
    "doctor.model_io": "模型 IO 记录",
    "doctor.model_io_off": "未开启全量保留（modelIoFullRetentionEnabled=false）。上下文成分分析仍可读取当前活跃会话的记录，但历史会话可能已被清理。",
    "doctor.retention_ok": "已开启全量保留，上下文成分分析可用。",
    "doctor.ledger": "账本存储",
    "doctor.ledger_sqlite": "SQLite（node:sqlite）",
    "doctor.ledger_jsonl": "JSONL 降级（node:sqlite 不可用）",
    "doctor.ok": "正常",
    "doctor.fail": "异常",
    "error.no_db": "找不到 ZCode 用量库：{path}",
    "error.no_sessions": "在范围 {scope} 内没有找到会话记录。",
    "error.no_rows": "在范围内没有已完成的模型请求记录。",
    "label.session": "会话",
    "label.workspace": "工作区",
    "label.period": "时间范围",
    "label.model": "模型",
    "label.share": "占比",
  },
  en: {
    "unit.tokens": "tokens",
    "unit.turns": "turns",
    "unit.requests": "requests",
    "report.title": "Usage and cost report",
    "report.scope": "Scope",
    "report.scope.session": "current session",
    "report.scope.workspace": "workspace",
    "report.scope.all": "all",
    "report.total": "Total",
    "report.fresh_input": "Fresh input",
    "report.cache_read": "Cache read",
    "report.cache_write": "Cache write",
    "report.output": "Output",
    "report.cost": "Cost",
    "report.requests": "Requests",
    "report.by_query_source": "By request source",
    "report.by_agent": "By agent",
    "report.by_mode": "By mode",
    "report.by_model": "By model",
    "report.by_tool": "By tool (token attribution)",
    "report.notes": "Notes",
    "note.cache_inclusive": "input_tokens already includes cache read and cache write; \"fresh input\" is the net value after subtracting them.",
    "note.cache_share": "Cache reads are {pct}% of total input; pricing input_tokens at the full input rate would overstate cost by about {factor}x.",
    "note.unpriced": "{count} model(s) have no pricing and their tokens are not costed: {models}",
    "note.cache_write_assumed": "Cache-write price missing upstream; estimated at {mult}x the input rate across {tokens} tokens.",
    "note.coverage": "Attribution coverage {pct}% (attributed growth / total growth).",
    "note.cache_write_zero": "Cache-write tokens are zero in this data, so the cache-write pricing assumption does not affect the result.",
    "doctor.title": "Self-check",
    "doctor.db": "Usage DB",
    "doctor.open_mode": "Read-only open mode",
    "doctor.index": "Session index",
    "doctor.node": "Node version",
    "doctor.sqlite": "Bundled SQLite",
    "doctor.snapshot": "Pricing snapshot",
    "doctor.snapshot_age": "Snapshot generated {days} day(s) ago",
    "doctor.unpriced": "Unpriced models",
    "doctor.model_io": "Model IO records",
    "doctor.model_io_off": "Full retention is off (modelIoFullRetentionEnabled=false). Context composition still reads the active session's records, but older sessions may be pruned.",
    "doctor.retention_ok": "Full retention is on; context composition is available.",
    "doctor.ledger": "Ledger store",
    "doctor.ledger_sqlite": "SQLite (node:sqlite)",
    "doctor.ledger_jsonl": "JSONL fallback (node:sqlite unavailable)",
    "doctor.ok": "ok",
    "doctor.fail": "fail",
    "error.no_db": "ZCode usage DB not found: {path}",
    "error.no_sessions": "No sessions found in scope {scope}.",
    "error.no_rows": "No completed model requests in scope.",
    "label.session": "Session",
    "label.workspace": "Workspace",
    "label.period": "Period",
    "label.model": "Model",
    "label.share": "Share",
  },
};

export function detectLocale(env = process.env, settings = null) {
  // 显式设置优先，但只接受能识别的值；"auto" 或未知值应继续走后面的探测，
  // 否则用户填了 auto 反而会被强制成英文。
  const explicit = env.SPEND_LEDGER_LANG || env.ZCODE_LANG;
  if (explicit && /^(zh|en)/i.test(explicit)) return normalizeLocale(explicit);
  const fromSettings = settings?.localePreference || settings?.locale;
  if (fromSettings && /^(zh|en)/i.test(fromSettings)) return normalizeLocale(fromSettings);
  return normalizeLocale(env.LANG || env.LC_ALL || "zh-CN");
}

function normalizeLocale(value) {
  const v = String(value).toLowerCase();
  if (v.startsWith("zh")) return "zh-CN";
  if (v.startsWith("en")) return "en";
  return "en";
}

export function createTranslator(locale) {
  const dict = DICTS[locale] || DICTS.en;
  const fallback = DICTS.en;
  return function t(key, vars) {
    let s = dict[key] ?? fallback[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    }
    return s;
  };
}
