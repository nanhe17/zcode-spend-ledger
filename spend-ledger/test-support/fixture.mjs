// 测试夹具：在一个临时 ZCODE_HOME 下建出与真实 ZCode 同构的用量库。
// 列名取自实机 P0 探针结果（db.sqlite 的 pragma table_info），
// 这样测试覆盖的是真实 SQL，而不是理想化的假表。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createFixtureHome() {
  const home = mkdtempSync(join(tmpdir(), "spend-ledger-test-"));
  mkdirSync(join(home, "cli", "db"), { recursive: true });
  mkdirSync(join(home, "v2"), { recursive: true });
  const dbPath = join(home, "cli", "db", "db.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return { home, db, dbPath, close: () => db.close() };
}

const SCHEMA = `
create table session (
  id text primary key, project_id text, workspace_id text, parent_id text, slug text,
  directory text, path text, title text, version text, share_url text,
  summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text,
  revert text, permission text, time_created integer, time_updated integer,
  time_compacting integer, time_archived integer, task_type text, title_source text,
  title_message_id text, time_title_updated integer, trace_id text
);
create table model_usage (
  id text primary key, logical_request_id text, attempt_index integer, session_id text, turn_id text,
  trace_id text, span_id text, assistant_message_id text, parent_user_message_id text,
  query_source text, provider_id text, model_id text, variant text, agent text, mode text,
  task_type text, status text, started_at integer, first_token_at integer, completed_at integer,
  duration_ms integer, time_to_first_token_ms integer, finish_reason text, tool_call_count integer,
  input_tokens integer, output_tokens integer, reasoning_tokens integer,
  cache_creation_input_tokens integer, cache_read_input_tokens integer,
  provider_total_tokens integer, computed_total_tokens integer,
  retry_count integer, retryable integer, cancelled_by_user integer, context_exceeded integer,
  error_type text, error_code text, error_message text, raw_usage_json text, provider_metadata_json text
);
create table turn_usage (
  session_id text, turn_id text, trace_id text, user_message_id text, status text,
  started_at integer, first_model_start_at integer, first_token_at integer, completed_at integer,
  duration_ms integer, time_to_first_token_ms integer, model_request_count integer,
  model_retry_count integer, tool_call_count integer, tool_error_count integer,
  input_tokens integer, output_tokens integer, reasoning_tokens integer,
  cache_creation_input_tokens integer, cache_read_input_tokens integer, computed_total_tokens integer,
  retryable integer, cancelled_by_user integer, context_exceeded integer, error_type text, error_code text,
  primary key (session_id, turn_id)
);
create table tool_usage (
  id text primary key, session_id text, turn_id text, trace_id text, tool_call_id text, tool_name text,
  side_effect_scope text, read_only integer, destructive integer, approval_status text, status text,
  started_at integer, first_output_at integer, completed_at integer, duration_ms integer,
  time_to_first_output_ms integer, exit_code integer, output_bytes integer, stdout_bytes integer,
  stderr_bytes integer, truncated integer, retry_count integer, retryable integer,
  cancelled_by_user integer, error_type text, error_code text, error_message text
);
create table part (
  id text primary key, message_id text, session_id text, time_created integer, time_updated integer,
  data text, sequence integer
);
`;

// 工作区路径刻意用 Windows 反斜杠，与真实 ZCode 库一致，
// 这样「调用方传正斜杠也要能命中」这件事才会被测到。
export const WS_DIR = "D:\\ws";

export function insertSession(db, { id, dir = WS_DIR, title = "fixture", createdAt = 1_700_000_000_000, taskType = "interactive" }) {
  db.prepare(
    `insert into session(id,directory,title,task_type,title_source,time_created,time_updated)
     values(?,?,?,?,?,?,?)`
  ).run(id, dir, title, taskType, "first_input", createdAt, createdAt + 60000);
}

export function insertRequest(db, r) {
  db.prepare(
    `insert into model_usage(
      id,logical_request_id,attempt_index,session_id,turn_id,query_source,provider_id,model_id,
      variant,agent,mode,task_type,status,started_at,first_token_at,completed_at,duration_ms,
      time_to_first_token_ms,finish_reason,tool_call_count,retry_count,retryable,cancelled_by_user,
      context_exceeded,input_tokens,output_tokens,reasoning_tokens,cache_creation_input_tokens,
      cache_read_input_tokens,provider_total_tokens,computed_total_tokens)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    r.id,
    r.logicalRequestId ?? r.id,
    r.attemptIndex ?? 0,
    r.sessionId,
    r.turnId ?? null,
    r.querySource ?? "main_turn",
    r.providerId ?? "builtin:zai",
    r.modelId ?? "glm-test",
    r.variant ?? "high",
    r.agent ?? "zcode-agent",
    r.mode ?? "build",
    r.taskType ?? "interactive",
    r.status ?? "completed",
    r.startedAt,
    r.firstTokenAt ?? r.startedAt + 100,
    r.completedAt ?? r.startedAt + 500,
    r.durationMs ?? 500,
    r.firstTokenMs ?? 100,
    r.finishReason ?? "tool-calls",
    r.toolCallCount ?? 0,
    r.retryCount ?? 0,
    0,
    0,
    0,
    r.inputTokens ?? 0,
    r.outputTokens ?? 0,
    r.reasoningTokens ?? 0,
    r.cacheCreationInputTokens ?? 0,
    r.cacheReadInputTokens ?? 0,
    (r.inputTokens ?? 0) + (r.outputTokens ?? 0),
    (r.inputTokens ?? 0) + (r.outputTokens ?? 0)
  );
}

export function insertTool(db, t) {
  db.prepare(
    `insert into tool_usage(id,session_id,turn_id,tool_call_id,tool_name,side_effect_scope,read_only,
      destructive,status,started_at,completed_at,duration_ms,output_bytes,exit_code,truncated)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    t.id ?? t.toolCallId,
    t.sessionId,
    t.turnId ?? null,
    t.toolCallId,
    t.toolName,
    t.sideEffectScope ?? "none",
    t.readOnly ?? 1,
    0,
    t.status ?? "completed",
    t.startedAt,
    t.completedAt ?? t.startedAt + 50,
    t.durationMs ?? 50,
    t.outputBytes ?? 0,
    t.exitCode ?? 0,
    0
  );
}

export function insertPart(db, { callId, sessionId, tool, filePath = null, outputChars = 0, at = 1_700_000_000_000, command = null }) {
  const data = {
    type: "tool",
    callID: callId,
    tool,
    state: {
      status: "completed",
      input: filePath ? { file_path: filePath } : command ? { command } : {},
      output: "x".repeat(outputChars),
      metadata: filePath ? { readFileState: { path: filePath } } : {},
      time: { start: at, end: at + 50 },
    },
  };
  db.prepare(
    `insert into part(id,message_id,session_id,time_created,time_updated,data,sequence)
     values(?,?,?,?,?,?,?)`
  ).run(`part_${callId}`, `msg_${callId}`, sessionId, at, at, JSON.stringify(data), 0);
}

export function insertTurn(db, t) {
  db.prepare(
    `insert into turn_usage(session_id,turn_id,status,started_at,completed_at,duration_ms,
      model_request_count,tool_call_count,tool_error_count,input_tokens,output_tokens,
      cache_creation_input_tokens,cache_read_input_tokens,computed_total_tokens)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    t.sessionId,
    t.turnId,
    t.status ?? "completed",
    t.startedAt,
    t.completedAt ?? t.startedAt + 1000,
    t.durationMs ?? 1000,
    t.modelRequestCount ?? 1,
    t.toolCallCount ?? 0,
    t.toolErrorCount ?? 0,
    t.inputTokens ?? 0,
    t.outputTokens ?? 0,
    t.cacheCreationInputTokens ?? 0,
    t.cacheReadInputTokens ?? 0,
    (t.inputTokens ?? 0) + (t.outputTokens ?? 0)
  );
}

// 供测试使用的定价快照
export function writeSnapshot(dir, models) {
  const path = join(dir, "pricing.snapshot.json");
  writeFileSync(path, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), unit: "usd_per_token", sources: [], models, rejected: [] }));
  return path;
}

export const TEST_RATES = {
  "glm-test": { input: 1e-6, output: 2e-6, cacheRead: 1e-7, cacheWrite: 5e-7, source: "test" },
};
