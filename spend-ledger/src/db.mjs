// 只读数据访问层。
//
// 用量账本在 ZCode 的 SQLite 里，且处于 WAL 模式、可能正在被写入。
// 打开采用三级降级，并把实际使用的方式暴露给 doctor：
//   1. readOnly 直连（实测可行，实测延迟 0.3ms 量级）
//   2. 把 db + -wal + -shm 复制到临时目录后读取快照（避免与活库争锁）
//   3. immutable=1（会看到旧数据，仅作最后手段）
//
// 本模块只执行 SELECT / PRAGMA，不写任何被读取的文件。
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zcodePaths } from "./paths.mjs";

// node:sqlite 需要 Node 22.5+，且 22/23 上需要 --experimental-sqlite 标志。
// 顶层 import 会在旧运行时直接抛栈崩掉整个插件，因此延迟加载并给出可读错误。
let sqliteModule;
export function loadSqlite() {
  if (sqliteModule === undefined) {
    try {
      sqliteModule = createRequire(import.meta.url)("node:sqlite");
    } catch {
      sqliteModule = null;
    }
  }
  return sqliteModule;
}

export const SQLITE_UNAVAILABLE_HINT =
  "本机 Node 缺少 node:sqlite（需要 Node 22.5+；Node 22/23 需要 --experimental-sqlite，Node 24+ 开箱可用）。" +
  "本插件的账本只能来自 ZCode 的 SQLite，因此无法降级读取。";

export const OPEN_MODES = {
  READ_ONLY: "readOnly",
  SNAPSHOT: "snapshot-copy",
  IMMUTABLE: "immutable",
  FAILED: "failed",
};

export function openUsageDb(opts = {}) {
  const p = opts.paths ?? zcodePaths(opts.env);
  const target = p.db;
  if (!existsSync(target)) {
    return { ok: false, mode: OPEN_MODES.FAILED, path: target, error: "db-not-found" };
  }
  const sqlite = loadSqlite();
  if (!sqlite) {
    return { ok: false, mode: OPEN_MODES.FAILED, path: target, error: "node-sqlite-unavailable", hint: SQLITE_UNAVAILABLE_HINT };
  }
  const { DatabaseSync } = sqlite;

  const errors = [];

  try {
    const db = new DatabaseSync(target, { readOnly: true });
    db.exec("pragma busy_timeout = 3000");
    return wrap(db, OPEN_MODES.READ_ONLY, target);
  } catch (err) {
    errors.push(`readOnly: ${err.message}`);
  }

  try {
    const dir = mkdtempSync(join(tmpdir(), "spend-ledger-snap-"));
    for (const suffix of ["", "-wal", "-shm"]) {
      const src = target + suffix;
      if (existsSync(src)) copyFileSync(src, join(dir, "db.sqlite" + suffix));
    }
    const db = new DatabaseSync(join(dir, "db.sqlite"), { readOnly: true });
    const w = wrap(db, OPEN_MODES.SNAPSHOT, target);
    w.tempDir = dir;
    return w;
  } catch (err) {
    errors.push(`snapshot: ${err.message}`);
  }

  try {
    const db = new DatabaseSync(`file:${target}?immutable=1`, { readOnly: true });
    const w = wrap(db, OPEN_MODES.IMMUTABLE, target);
    w.degraded = true;
    return w;
  } catch (err) {
    errors.push(`immutable: ${err.message}`);
    return { ok: false, mode: OPEN_MODES.FAILED, path: target, error: errors.join(" | ") };
  }
}

function wrap(db, mode, path) {
  return {
    ok: true,
    db,
    mode,
    path,
    tempDir: null,
    degraded: mode !== OPEN_MODES.READ_ONLY,
    bytes: existsSync(path) ? statSync(path).size : null,
    close() {
      try {
        db.close();
      } catch {
        /* 已关闭 */
      }
      if (this.tempDir) {
        try {
          rmSync(this.tempDir, { recursive: true, force: true });
        } catch {
          /* 忽略 */
        }
      }
    },
    meta() {
      const one = (sql) => db.prepare(sql).get();
      const out = { mode, path, sqlite: null, journal: null, json1: false };
      try {
        out.sqlite = one("select sqlite_version() v").v;
        out.journal = one("pragma journal_mode").journal_mode;
        one(`select json_extract('{"a":1}','$.a') v`);
        out.json1 = true;
      } catch {
        /* 保持默认 */
      }
      return out;
    },
  };
}

// ---- 作用域构造 ----
// 工作区路径归一化：ZCode 库里目录存的是 Windows 反斜杠（D:\ZcodeWorkSpace），
// 而调用方传来的往往是正斜杠或带尾斜杠的形式，直接字符串比较会永远匹配不上。
// 因此两侧都归一化为「小写 + 正斜杠 + 去尾斜杠」后再比较。
const WS_NORM = (col) => `lower(rtrim(replace(${col}, '\\', '/'), '/'))`;

export function normalizeWorkspace(value) {
  return String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

// 统一用子查询表达 workspace 过滤，这样所有查询（含不 join session 的 part 查询）都适用。
function scopeSql(filter, sessionCol, timeCol) {
  const where = [];
  const params = {};
  if (filter.sessionIds?.length) {
    const keys = filter.sessionIds.map((id, i) => {
      params[`sid${i}`] = id;
      return `$sid${i}`;
    });
    where.push(`${sessionCol} in (${keys.join(",")})`);
  } else if (filter.sessionId) {
    where.push(`${sessionCol} = $sessionId`);
    params.sessionId = filter.sessionId;
  }
  if (filter.workspace) {
    where.push(`${sessionCol} in (select id from session where ${WS_NORM("directory")} = $workspace)`);
    params.workspace = normalizeWorkspace(filter.workspace);
  }
  if (filter.since) {
    where.push(`${timeCol} >= $since`);
    params.since = filter.since;
  }
  if (filter.until) {
    where.push(`${timeCol} <= $until`);
    params.until = filter.until;
  }
  return { where, params };
}

const clampLimit = (v, dflt = 200) => Math.min(Math.max(Number(v) || dflt, 1), 5000);

export function findSessions(conn, filter = {}) {
  const where = [];
  const params = {};
  if (filter.sessionId) {
    where.push("id = $sessionId");
    params.sessionId = filter.sessionId;
  }
  if (filter.workspace) {
    where.push(`${WS_NORM("directory")} = $workspace`);
    params.workspace = normalizeWorkspace(filter.workspace);
  }
  if (filter.since) {
    where.push("time_created >= $since");
    params.since = filter.since;
  }
  if (filter.until) {
    where.push("time_created <= $until");
    params.until = filter.until;
  }
  if (!filter.includeSubagents) where.push("id not like 'sess_subagent_%'");
  const sql = `select id, directory, title, task_type, title_source, time_created, time_updated
    from session ${where.length ? "where " + where.join(" and ") : ""}
    order by time_created desc limit ${clampLimit(filter.limit)}`;
  return conn.db.prepare(sql).all(params);
}

export function latestSession(conn, { workspace, includeSubagents = false } = {}) {
  return findSessions(conn, { workspace, includeSubagents, limit: 1 })[0] ?? null;
}

export function countSessions(conn, filter = {}) {
  const rows = findSessions(conn, { ...filter, limit: 5000 });
  return rows.length;
}

// ---- 用量行 ----

export function usageRows(conn, filter = {}) {
  const { where, params } = scopeSql(filter, "m.session_id", "m.started_at");
  if (!filter.includeUnfinished) where.push("m.status = 'completed'");
  const sql = `select m.id, m.logical_request_id, m.attempt_index, m.session_id, m.turn_id,
      m.query_source, m.provider_id, m.model_id, m.variant, m.agent, m.mode, m.task_type,
      m.status, m.started_at, m.completed_at, m.duration_ms, m.time_to_first_token_ms,
      m.finish_reason, m.tool_call_count, m.retry_count, m.retryable, m.cancelled_by_user,
      m.context_exceeded, m.error_type,
      m.input_tokens, m.output_tokens, m.reasoning_tokens,
      m.cache_creation_input_tokens, m.cache_read_input_tokens, m.computed_total_tokens,
      s.directory as workspace
    from model_usage m left join session s on s.id = m.session_id
    ${where.length ? "where " + where.join(" and ") : ""}
    order by m.started_at asc`;
  return conn.db.prepare(sql).all(params);
}

export function turnRows(conn, filter = {}) {
  const { where, params } = scopeSql(filter, "t.session_id", "t.started_at");
  return conn.db
    .prepare(
      `select t.*, s.directory as workspace from turn_usage t
       left join session s on s.id = t.session_id
       ${where.length ? "where " + where.join(" and ") : ""} order by t.started_at asc`
    )
    .all(params);
}

export function toolRows(conn, filter = {}) {
  const { where, params } = scopeSql(filter, "u.session_id", "u.started_at");
  return conn.db
    .prepare(
      `select u.id, u.session_id, u.turn_id, u.tool_call_id, u.tool_name, u.side_effect_scope,
          u.read_only, u.destructive, u.status, u.started_at, u.first_output_at, u.completed_at,
          u.duration_ms, u.output_bytes, u.exit_code, u.truncated, u.error_type
       from tool_usage u
       ${where.length ? "where " + where.join(" and ") : ""} order by u.started_at asc`
    )
    .all(params);
}

// 工具结果细节：文件路径有三个来源，按可用性依次回退。
export function toolDetails(conn, filter = {}) {
  const { where, params } = scopeSql(filter, "p.session_id", "p.time_created");
  return conn.db
    .prepare(
      `select
        json_extract(p.data,'$.callID') as tool_call_id,
        json_extract(p.data,'$.tool') as tool_name,
        json_extract(p.data,'$.state.status') as status,
        coalesce(
          json_extract(p.data,'$.state.input.file_path'),
          json_extract(p.data,'$.state.metadata.readFileState.path'),
          json_extract(p.data,'$.state.metadata.display.filePath')
        ) as file_path,
        json_extract(p.data,'$.state.input.command') as command,
        json_extract(p.data,'$.state.input.url') as url,
        json_extract(p.data,'$.state.metadata.serialization.budgetStrategy') as budget_strategy,
        json_extract(p.data,'$.state.metadata.serialization.truncated') as truncated,
        length(json_extract(p.data,'$.state.output')) as output_chars,
        p.session_id
      from part p
      where json_extract(p.data,'$.type')='tool'
        ${where.length ? "and " + where.join(" and ") : ""}`
    )
    .all(params);
}

// 会话索引库（第二个库）：提供标题、模式、模型等展示信息
export function loadTasksIndex(env = process.env, limit = 500) {
  const p = zcodePaths(env);
  if (!existsSync(p.tasksIndex)) return { ok: false, tasks: [], error: "index-not-found" };
  const sqlite = loadSqlite();
  if (!sqlite) return { ok: false, tasks: [], error: "node-sqlite-unavailable" };
  let db;
  try {
    db = new sqlite.DatabaseSync(p.tasksIndex, { readOnly: true });
    const tasks = db
      .prepare(
        `select workspace_path, task_id, title, model, provider, mode, task_status, created_at, updated_at
         from tasks order by updated_at desc limit ${clampLimit(limit)}`
      )
      .all();
    return { ok: true, tasks };
  } catch (err) {
    return { ok: false, tasks: [], error: String(err.message) };
  } finally {
    try {
      db?.close();
    } catch {
      /* 忽略 */
    }
  }
}

// ---- 厂商与模型清单（来自 v2/config.json）----
// provider_id 在数据里可能是不透明 UUID（如 f1555b88-…）也可能是 builtin:zai，
// 因此需要这张表把 id 映射成可读名字，并作为定价匹配时的候选前缀。
// 只读取 name/kind/models，绝不带出凭据字段。
export function loadProviderCatalog(env = process.env) {
  const p = zcodePaths(env);
  if (!existsSync(p.providerConfig)) return { providers: {}, models: [], error: "config-not-found" };
  try {
    const raw = JSON.parse(readFileSync(p.providerConfig, "utf8"));
    const providers = {};
    const models = [];
    for (const [id, prov] of Object.entries(raw.provider ?? {})) {
      if (!prov || typeof prov !== "object") continue;
      const name = prov.name ?? id;
      const slug = slugify(name);
      providers[id] = { name, kind: prov.kind ?? null, slug, enabled: prov.enabled !== false };
      for (const modelId of Object.keys(prov.models ?? {})) {
        models.push({ providerId: id, providerLabel: name, slug, modelId });
      }
    }
    return { providers, models };
  } catch (err) {
    return { providers: {}, models: [], error: String(err.message) };
  }
}

export function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function providerSlug(providerId, catalog) {
  if (!providerId) return null;
  if (providerId.startsWith("builtin:")) return slugify(providerId.slice("builtin:".length));
  const hit = catalog?.providers?.[providerId];
  return hit ? hit.slug : null;
}

export function readSettings(env = process.env) {
  const p = zcodePaths(env);
  if (!existsSync(p.settings)) return {};
  try {
    return JSON.parse(readFileSync(p.settings, "utf8"));
  } catch {
    return {};
  }
}
