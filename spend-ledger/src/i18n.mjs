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
    "check.node": "Node 与内置 SQLite",
    "check.data-dir": "插件数据目录",
    "check.usage-db": "用量库",
    "check.open-mode": "只读打开方式",
    "check.json1": "JSON1 支持",
    "check.tasks-index": "会话索引",
    "check.ledger": "账本存储",
    "check.pricing-snapshot": "定价快照",
    "check.unpriced-models": "未定价模型",
    "check.model-io": "模型 IO 记录",
    "doctor.ok": "正常",
    "doctor.fail": "异常",
    "doctor.warn": "注意",
    "doctor.col.check": "检查项",
    "doctor.col.status": "状态",
    "doctor.col.detail": "详情",
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
    "check.node": "Node and bundled SQLite",
    "check.data-dir": "Plugin data directory",
    "check.usage-db": "Usage DB",
    "check.open-mode": "Read-only open mode",
    "check.json1": "JSON1 support",
    "check.tasks-index": "Session index",
    "check.ledger": "Ledger store",
    "check.pricing-snapshot": "Pricing snapshot",
    "check.unpriced-models": "Unpriced models",
    "check.model-io": "Model IO records",
    "doctor.ok": "ok",
    "doctor.fail": "fail",
    "doctor.warn": "warn",
    "doctor.col.check": "check",
    "doctor.col.status": "status",
    "doctor.col.detail": "detail",
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

export const DEFAULT_LOCALE = "zh-CN";

// 只认能识别的语言代码；识别不了就返回 null，交给下一个信号。
// 早先的实现对无法识别的值返回 "en"，于是 `localePreference: "system"` 这类模式词
// 和 `LANG=C.UTF-8` 这类中性值都会把界面强行变成英文。
function normalizeLocale(value) {
  if (!value) return null;
  const v = String(value).toLowerCase();
  if (v.startsWith("zh")) return "zh-CN";
  if (v.startsWith("en")) return "en";
  return null;
}

export function detectLocale(env = process.env, settings = null) {
  // 优先级：显式环境变量 → ZCode 的语言偏好 → ZCode 的界面语言 → 系统 locale。
  // settings.localePreference 可能是 "system" 这样的模式词，因此用「能识别才采纳」的方式逐个尝试。
  const candidates = [env.SPEND_LEDGER_LANG, env.ZCODE_LANG, settings?.localePreference, settings?.locale, env.LC_ALL, env.LANG];
  for (const candidate of candidates) {
    const norm = normalizeLocale(candidate);
    if (norm) return norm;
  }
  return DEFAULT_LOCALE;
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
