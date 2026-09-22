// P0 探针：验证 ZCode 用量库的只读可访问性与字段语义。
// 只做 SELECT 与文件读取，不写入任何被探测的文件。
// 用法：node scripts/p0-probe.mjs [--json]
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const asJson = process.argv.includes("--json");
const out = [];
const say = (label, value) => out.push([label, value]);

const home = process.env.ZCODE_HOME || join(homedir(), ".zcode");
const dbPath = join(home, "cli", "db", "db.sqlite");
const indexPath = join(home, "v2", "tasks-index.sqlite");
const rolloutDir = join(home, "cli", "rollout");
const configPath = join(home, "v2", "config.json");
const settingPath = join(home, "v2", "setting.json");

say("zcode_home", home);
say("db_exists", existsSync(dbPath));
say("db_bytes", existsSync(dbPath) ? statSync(dbPath).size : null);
say("wal_exists", existsSync(dbPath + "-wal"));
say("shm_exists", existsSync(dbPath + "-shm"));

// --- 1. 只读直连活库 ---
let openMode = "readOnly";
let db = null;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec("pragma busy_timeout = 3000");
  say("open_readonly", "OK");
} catch (err) {
  say("open_readonly", "FAILED: " + err.message);
  try {
    db = new DatabaseSync(`file:${dbPath}?immutable=1`, { readOnly: true });
    openMode = "immutable";
    say("open_immutable", "OK");
  } catch (err2) {
    say("open_immutable", "FAILED: " + err2.message);
  }
}
say("open_mode_effective", db ? openMode : "NONE");

if (db) {
  const one = (sql) => db.prepare(sql).get();
  const all = (sql) => db.prepare(sql).all();

  say("sqlite_version", one("select sqlite_version() v").v);
  say("journal_mode", one("pragma journal_mode").journal_mode);

  // --- 2. JSON1 ---
  try {
    say("json1", one(`select json_extract('{"a":{"b":7}}','$.a.b') v`).v);
  } catch (err) {
    say("json1", "UNAVAILABLE: " + err.message);
  }

  const tables = all("select name from sqlite_master where type='table' order by name").map((r) => r.name);
  say("tables", tables);

  const cols = (t) => {
    try {
      return db.prepare(`pragma table_info(${t})`).all().map((r) => r.name);
    } catch (err) {
      return "ERR: " + err.message;
    }
  };
  for (const t of ["model_usage", "turn_usage", "tool_usage", "message", "part", "session"]) {
    if (tables.includes(t)) say(`cols_${t}`, cols(t));
  }

  const counts = {};
  for (const t of ["session", "message", "part", "model_usage", "turn_usage", "tool_usage"]) {
    if (tables.includes(t)) counts[t] = one(`select count(*) c from ${t}`).c;
  }
  say("counts", counts);

  // --- 3. 缓存语义断言 ---
  const sem = one(`select
      sum(case when cache_read_input_tokens > input_tokens then 1 else 0 end) as cache_gt_input,
      sum(case when computed_total_tokens = input_tokens + output_tokens then 1 else 0 end) as total_eq_sum,
      count(*) as rows_all,
      sum(case when status='completed' then 1 else 0 end) as rows_completed
    from model_usage`);
  say("semantics_cache_gt_input_rows", sem.cache_gt_input);
  say("semantics_total_eq_input_plus_output_rows", sem.total_eq_sum);
  say("semantics_rows_all", sem.rows_all);
  say("semantics_rows_completed", sem.rows_completed);

  const agg = one(`select
      sum(input_tokens) i, sum(cache_read_input_tokens) cr, sum(cache_creation_input_tokens) cc,
      sum(output_tokens) o, sum(reasoning_tokens) r
    from model_usage where status='completed'`);
  say("agg_completed", agg);
  if (agg.i) {
    say("cache_read_share_pct", Number(((agg.cr / agg.i) * 100).toFixed(2)));
    say("fresh_input_fraction_pct", Number((((agg.i - agg.cr - agg.cc) / agg.i) * 100).toFixed(2)));
  }

  say("worst_cache_row", one(`select model_id, input_tokens, cache_read_input_tokens, output_tokens,
      round(100.0*cache_read_input_tokens/nullif(input_tokens,0),1) as pct
    from model_usage where status='completed' order by pct desc limit 1`));

  // --- 4. 维度可用性（归因的基础）---
  for (const dim of ["query_source", "agent", "mode", "task_type", "variant", "status", "provider_id", "model_id"]) {
    if ((cols("model_usage") || []).includes(dim)) {
      say(`dim_${dim}`, all(`select ${dim} k, count(*) c, sum(input_tokens) i from model_usage group by 1 order by i desc limit 8`));
    }
  }

  // --- 5. 归因 join 可行性 ---
  const partHasCall = one(`select count(*) c from part where json_extract(data,'$.callID') is not null`).c;
  say("part_rows_with_callID", partHasCall);
  const joinable = one(`select count(*) c from tool_usage t
      join part p on json_extract(p.data,'$.callID') = t.tool_call_id`).c;
  say("tool_usage_joinable_to_part", joinable);
  say("tool_usage_rows", one("select count(*) c from tool_usage").c);

  say("tool_path_extract_sample", one(`select
      json_extract(data,'$.state.input.file_path') as input_path,
      json_extract(data,'$.state.metadata.readFileState.path') as read_path,
      json_extract(data,'$.state.metadata.serialization.budgetStrategy') as budget
    from part where json_extract(data,'$.type')='tool' limit 3`));
  say("tool_name_top", all(`select tool_name, count(*) c, sum(output_bytes) bytes from tool_usage group by 1 order by c desc limit 12`));
  say("mcp_tool_spend_proxy", one(`select count(*) c, sum(output_bytes) bytes from tool_usage where tool_name like 'mcp__%'`));

  // 负增量（上下文压缩）出现频率：同 turn 内输入回退
  say("negative_delta_turns", one(`with o as (
      select turn_id, started_at, input_tokens,
             lag(input_tokens) over (partition by turn_id order by started_at) prev
      from model_usage where status='completed' and turn_id is not null)
    select sum(case when prev is not null and input_tokens < prev then 1 else 0 end) neg,
           sum(case when prev is not null then 1 else 0 end) pairs from o`));

  const t0 = process.hrtime.bigint();
  db.prepare(`select query_source, agent, mode, model_id, count(*) c,
      sum(input_tokens) i, sum(output_tokens) o, sum(cache_read_input_tokens) cr
    from model_usage where status='completed' group by 1,2,3,4`).all();
  const t1 = process.hrtime.bigint();
  say("groupby_latency_ms", Number(t1 - t0) / 1e6);
}

// --- 6. 会话索引库（第二个库）---
if (existsSync(indexPath)) {
  try {
    const idx = new DatabaseSync(indexPath, { readOnly: true });
    say("index_open", "OK");
    say("index_cols_tasks", idx.prepare("pragma table_info(tasks)").all().map((r) => r.name));
    say("index_recent_tasks", idx.prepare(
      "select workspace_path, task_id, title, model, provider, mode, status from tasks order by updated_at desc limit 5"
    ).all());
    idx.close();
  } catch (err) {
    say("index_open", "FAILED: " + err.message);
  }
} else {
  say("index_open", "NOT FOUND");
}

// --- 7. model-io 保留情况 ---
if (existsSync(rolloutDir)) {
  const files = readdirSync(rolloutDir).filter((f) => f.startsWith("model-io-"));
  say("model_io_files", files.map((f) => ({ name: f, bytes: statSync(join(rolloutDir, f)).size })));
} else {
  say("model_io_files", "ROLLOUT DIR NOT FOUND");
}

// --- 8. 配置文件结构（脱敏：不输出任何疑似凭据的值）---
const REDACT = /key|token|secret|password|auth|credential/i;
function shape(value, depth = 0, prefix = "") {
  if (depth > 3) return "…";
  if (Array.isArray(value)) return `[array len=${value.length}]` + (value.length ? shape(value[0], depth + 1, prefix) : "");
  if (value && typeof value === "object") {
    const o = {};
    for (const [k, v] of Object.entries(value)) {
      o[k] = REDACT.test(k) ? "<redacted>" : shape(v, depth + 1, prefix + "." + k);
    }
    return o;
  }
  if (typeof value === "string") return value.length > 60 ? value.slice(0, 60) + "…" : value;
  return value === null ? null : typeof value;
}
if (existsSync(configPath)) {
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    say("config_top_keys", Object.keys(cfg));
    say("config_shape", shape(cfg));
  } catch (err) {
    say("config_parse", "FAILED: " + err.message);
  }
}
if (existsSync(settingPath)) {
  try {
    const st = JSON.parse(readFileSync(settingPath, "utf8"));
    const hits = {};
    for (const [k, v] of Object.entries(st)) if (/modelIo|retention|archive/i.test(k)) hits[k] = v;
    say("setting_retention_keys", hits);
    say("setting_all_keys", Object.keys(st));
  } catch (err) {
    say("setting_parse", "FAILED: " + err.message);
  }
}

if (asJson) {
  console.log(JSON.stringify(Object.fromEntries(out), null, 2));
} else {
  for (const [k, v] of out) {
    const body = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
    console.log(k.padEnd(38), body.length > 700 ? body.slice(0, 700) + " …" : body);
  }
}
if (db) db.close();
