// 账本：跨会话的派生数据存储（水位线、已报告过的建议、历史报告）。
//
// 优先用 node:sqlite（Node 22.5+ 内置，实测本机 Node 24 可用、SQLite 3.51）。
// 若运行在 Electron host 下且 node:sqlite 不可用，降级为 append-only JSONL + 内存折叠
// （mimosa 用的就是这个模式）。降级是自动的，调用方无需分支。
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dataFile } from "./paths.mjs";

export const LEDGER_VERSION = 1;

// node:sqlite 在 Node 22.5+ 才存在，且 Electron host 运行时未必可用。
// 顶层 import 会让旧运行时直接崩掉，因此延迟加载并缓存探测结果。
let sqliteModule;
function loadSqlite() {
  if (sqliteModule === undefined) {
    try {
      sqliteModule = createRequire(import.meta.url)("node:sqlite");
    } catch {
      sqliteModule = null;
    }
  }
  return sqliteModule;
}

export function ledgerStatus(env = process.env) {
  const path = dataFile("ledger.sqlite", env);
  const jsonlPath = dataFile("ledger.jsonl", env);
  const mod = loadSqlite();
  const sqlite = typeof mod?.DatabaseSync === "function";
  return {
    kind: sqlite ? "sqlite" : "jsonl",
    path: sqlite ? path : jsonlPath,
    sqliteAvailable: sqlite,
    exists: existsSync(sqlite ? path : jsonlPath),
  };
}


export function openLedger(env = process.env) {
  const status = ledgerStatus(env);
  return status.sqliteAvailable ? sqliteLedger(status.path) : jsonlLedger(status.path);
}

function sqliteLedger(path) {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal");
  db.exec(`
    create table if not exists meta (key text primary key, value text);
    create table if not exists watermark (
      session_id text primary key,
      last_completed_at integer,
      last_logical_request_id text,
      updated_at integer
    );
    create table if not exists finding (
      id text primary key,
      rule text not null,
      severity text,
      first_seen integer,
      last_seen integer,
      occurrences integer default 1,
      evidence text,
      saving_tokens integer default 0,
      dismissed integer default 0
    );
    create table if not exists report_run (
      id integer primary key autoincrement,
      at integer, scope text, session_id text,
      cost_usd real, input_tokens integer, output_tokens integer
    );
  `);
  db.prepare("insert or replace into meta(key,value) values('schema_version',?)").run(String(LEDGER_VERSION));

  return {
    kind: "sqlite",
    path,
    getMeta(key) {
      return db.prepare("select value from meta where key=?").get(key)?.value ?? null;
    },
    setMeta(key, value) {
      db.prepare("insert or replace into meta(key,value) values(?,?)").run(key, String(value));
    },
    getWatermark(sessionId) {
      return db.prepare("select * from watermark where session_id=?").get(sessionId) ?? null;
    },
    setWatermark(sessionId, completedAt, logicalRequestId) {
      db.prepare(
        `insert into watermark(session_id,last_completed_at,last_logical_request_id,updated_at)
         values(?,?,?,?)
         on conflict(session_id) do update set
           last_completed_at=excluded.last_completed_at,
           last_logical_request_id=excluded.last_logical_request_id,
           updated_at=excluded.updated_at`
      ).run(sessionId, completedAt ?? 0, logicalRequestId ?? null, Date.now());
    },
    recordFindings(findings) {
      const stmt = db.prepare(
        `insert into finding(id,rule,severity,first_seen,last_seen,occurrences,evidence,saving_tokens)
         values(?,?,?,?,?,1,?,?)
         on conflict(id) do update set last_seen=excluded.last_seen,
           occurrences=finding.occurrences+1,
           evidence=excluded.evidence,
           saving_tokens=excluded.saving_tokens`
      );
      const now = Date.now();
      for (const f of findings) stmt.run(f.id, f.rule, f.severity ?? "info", now, now, JSON.stringify(f.evidence ?? {}), f.savingTokens ?? 0);
    },
    listFindings({ includeDismissed = false } = {}) {
      return db
        .prepare(`select * from finding ${includeDismissed ? "" : "where dismissed=0"} order by saving_tokens desc`)
        .all();
    },
    dismissFinding(id) {
      db.prepare("update finding set dismissed=1 where id=?").run(id);
    },
    recordReportRun({ scope, sessionId, costUsd, inputTokens, outputTokens }) {
      db.prepare("insert into report_run(at,scope,session_id,cost_usd,input_tokens,output_tokens) values(?,?,?,?,?,?)").run(
        Date.now(),
        scope ?? null,
        sessionId ?? null,
        costUsd ?? 0,
        inputTokens ?? 0,
        outputTokens ?? 0
      );
    },
    history(limit = 20) {
      return db.prepare("select * from report_run order by at desc limit ?").all(limit);
    },
    close() {
      try {
        db.close();
      } catch {
        /* 忽略 */
      }
    },
  };
}

// JSONL 降级：append-only，读取时折叠。容量远小于 SQLite 版，但保证功能不缺失。
function jsonlLedger(path) {
  const load = () => {
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const out = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 跳过损坏行 */
      }
    }
    return out;
  };
  const append = (obj) => appendFileSync(path, JSON.stringify(obj) + "\n");
  const state = () => {
    const s = { meta: {}, watermark: {}, findings: new Map(), reports: [] };
    for (const rec of load()) {
      if (rec.t === "meta") s.meta[rec.k] = rec.v;
      else if (rec.t === "wm") s.watermark[rec.sessionId] = rec;
      else if (rec.t === "finding") {
        const prev = s.findings.get(rec.f.id);
        s.findings.set(rec.f.id, { ...rec.f, occurrences: (prev?.occurrences ?? 0) + 1, dismissed: rec.f.dismissed ?? prev?.dismissed ?? 0 });
      } else if (rec.t === "run") s.reports.push(rec);
    }
    return s;
  };

  return {
    kind: "jsonl",
    path,
    getMeta(key) {
      return state().meta[key] ?? null;
    },
    setMeta(key, value) {
      append({ t: "meta", k: key, v: String(value) });
    },
    getWatermark(sessionId) {
      return state().watermark[sessionId] ?? null;
    },
    setWatermark(sessionId, completedAt, logicalRequestId) {
      append({ t: "wm", sessionId, completedAt: completedAt ?? 0, logicalRequestId: logicalRequestId ?? null, at: Date.now() });
    },
    recordFindings(findings) {
      for (const f of findings) append({ t: "finding", f: { id: f.id, rule: f.rule, severity: f.severity ?? "info", evidence: f.evidence ?? {}, savingTokens: f.savingTokens ?? 0, at: Date.now() } });
    },
    listFindings({ includeDismissed = false } = {}) {
      return [...state().findings.values()].filter((f) => includeDismissed || !f.dismissed).sort((a, b) => (b.savingTokens ?? 0) - (a.savingTokens ?? 0));
    },
    dismissFinding(id) {
      append({ t: "finding", f: { id, dismissed: 1, rule: "dismiss", at: Date.now() } });
    },
    recordReportRun(run) {
      append({ t: "run", ...run, at: Date.now() });
    },
    history(limit = 20) {
      return state().reports.slice(-limit).reverse();
    },
    close() {},
  };
}
