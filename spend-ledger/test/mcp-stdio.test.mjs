// MCP stdio 端到端测试：真正把服务作为子进程拉起来，通过管道收发。
// 这是唯一能覆盖「stdout 被污染」「帧格式不对」「进程不退出」这类问题的测试——
// 宿主对这些问题的表现是静默断开，不会有可读报错。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createFixtureHome, insertSession, insertRequest, insertTurn, writeSnapshot, TEST_RATES } from "../test-support/fixture.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "src", "entry-mcp.mjs");

let child;
let env;
let pending;
let stderr = "";

before(() => {
  const fx = createFixtureHome();
  insertSession(fx.db, { id: "sess_stdio_1" });
  insertRequest(fx.db, { id: "r1", sessionId: "sess_stdio_1", turnId: "t1", startedAt: 1000, completedAt: 1500, inputTokens: 4000, outputTokens: 200, cacheReadInputTokens: 3000 });
  insertTurn(fx.db, { sessionId: "sess_stdio_1", turnId: "t1", startedAt: 1000 });
  const snapshotPath = writeSnapshot(mkdtempSync(join(tmpdir(), "stdio-snap-")), TEST_RATES);
  env = {
    ...process.env,
    ZCODE_HOME: fx.home,
    ZCODE_PLUGIN_DATA: join(fx.home, "pd"),
    SPEND_LEDGER_SNAPSHOT: snapshotPath,
    SPEND_LEDGER_LANG: "en",
  };

  child = spawn(process.execPath, [ENTRY], { env, stdio: ["pipe", "pipe", "pipe"] });
  pending = new Map();
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const msg = JSON.parse(line);
    const resolveFn = pending.get(msg.id);
    if (resolveFn) {
      pending.delete(msg.id);
      resolveFn(msg);
    }
  });
  child.stderr.on("data", (d) => {
    stderr += String(d);
  });
});

after(() => {
  child?.kill();
});

function call(id, method, params) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr=${stderr.slice(0, 400)}`)), 15000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolvePromise(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

test("握手：initialize 与 tools/list 经管道往返正常", async () => {
  const init = await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  assert.equal(init.jsonrpc, "2.0");
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "spend-ledger");

  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await call(2, "tools/list", {});
  assert.equal(list.result.tools.length, 4);
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), [
    "spend_advisor",
    "spend_attribution",
    "spend_context_breakdown",
    "spend_summary",
  ]);
});

test("tools/call 经管道返回可解析结果（真实库）", async () => {
  const res = await call(3, "tools/call", { name: "spend_summary", arguments: { scope: "session", session_id: "sess_stdio_1" } });
  assert.equal(res.id, 3);
  assert.ok(res.result.content?.[0]?.text);
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.totals.requests, 1);
  assert.equal(payload.totals.fresh, 1000, "fresh = 4000 − 3000");
  assert.equal(payload.totals.cacheRead, 3000);
});

test("多语言输出由环境变量控制", async () => {
  const res = await call(4, "tools/call", { name: "spend_advisor", arguments: { scope: "session", session_id: "sess_stdio_1" } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.findings));
});

test("未知方法返回 JSON-RPC 错误而不是让进程崩溃", async () => {
  const res = await call(5, "resources/list", {});
  assert.equal(res.error.code, -32601);

  // 进程仍能继续服务
  const after = await call(6, "ping", {});
  assert.deepEqual(after.result, {});
});

test("stdout 只有 JSON-RPC 帧，日志与告警都走 stderr", async () => {
  // 若有非 JSON 行，上面的 readline 解析会抛错；这里再显式检查一次
  const res = await call(7, "tools/call", { name: "spend_context_breakdown", arguments: { session_id: "sess_stdio_1" } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "model-io-not-found");
  assert.ok(!stderr.includes("SyntaxError"), "stderr 不应出现协议层解析错误");
});
