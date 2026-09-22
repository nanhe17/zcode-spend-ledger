// MCP 协议测试：手写 JSON-RPC 最容易出的错是协议形状不对（缺 id、错误码错、
// 通知被回复），这些都会让宿主静默断开连接，所以逐条断言。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMessage, TOOLS, SERVER_INFO, PROTOCOL_FALLBACK, callTool } from "../src/mcp-server.mjs";
import { createFixtureHome, insertSession, insertRequest, insertTurn, writeSnapshot, TEST_RATES } from "../test-support/fixture.mjs";

const fx = createFixtureHome();
insertSession(fx.db, { id: "sess_mcp_1" });
insertRequest(fx.db, { id: "r1", sessionId: "sess_mcp_1", turnId: "t1", startedAt: 1000, completedAt: 1500, inputTokens: 1000, outputTokens: 100 });
insertTurn(fx.db, { sessionId: "sess_mcp_1", turnId: "t1", startedAt: 1000 });
const snapshotPath = writeSnapshot(mkdtempSync(join(tmpdir(), "mcp-snap-")), TEST_RATES);
const env = { ...process.env, ZCODE_HOME: fx.home, ZCODE_PLUGIN_DATA: join(fx.home, "pd"), SPEND_LEDGER_SNAPSHOT: snapshotPath };

test("initialize 回显客户端协议版本并声明 tools 能力", async () => {
  const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, env);
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, "2025-06-18");
  assert.deepEqual(res.result.capabilities, { tools: { listChanged: false } });
  assert.deepEqual(res.result.serverInfo, SERVER_INFO);
});

test("initialize 缺协议版本时回退到默认值", async () => {
  const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, env);
  assert.equal(res.result.protocolVersion, PROTOCOL_FALLBACK);
});

test("通知不产生回复（否则宿主会认为协议出错）", async () => {
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, env), null);
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }, env), null);
});

test("ping 返回空结果", async () => {
  const res = await handleMessage({ jsonrpc: "2.0", id: 7, method: "ping" }, env);
  assert.deepEqual(res, { jsonrpc: "2.0", id: 7, result: {} });
});

test("tools/list 暴露四个工具且都有合法 inputSchema", async () => {
  const res = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, env);
  const names = res.result.tools.map((t) => t.name);
  assert.deepEqual(names, ["spend_summary", "spend_attribution", "spend_context_breakdown", "spend_advisor"]);
  for (const t of res.result.tools) {
    assert.equal(typeof t.description, "string");
    assert.ok(t.description.length > 20, `${t.name} 的描述应当说明用途`);
    assert.equal(t.inputSchema.type, "object");
  }
});

test("未知方法返回 -32601", async () => {
  const res = await handleMessage({ jsonrpc: "2.0", id: 3, method: "resources/list" }, env);
  assert.equal(res.error.code, -32601);
});

test("tools/call 返回 content 文本块且内容可解析", async () => {
  const res = await handleMessage(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "spend_summary", arguments: { scope: "session", session_id: "sess_mcp_1" } } },
    env
  );
  assert.equal(res.id, 4);
  assert.equal(res.result.content[0].type, "text");
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.totals.requests, 1);
});

test("未知工具名以 isError 返回而不是抛出", async () => {
  const res = await handleMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } }, env);
  assert.equal(res.result.isError, true);
  assert.match(JSON.parse(res.result.content[0].text).error, /Unknown tool/);
});

test("summary 不回传完整请求明细（控制载荷体积）", async () => {
  const r = await callTool("spend_summary", { scope: "session", session_id: "sess_mcp_1" }, env);
  assert.equal(r.requests, undefined, "明细数组不应出现在 MCP 响应里");
  assert.ok(r.totals);
  assert.ok(r.dimensions);
});

test("attribution 工具返回覆盖率与分解", async () => {
  const r = await callTool("spend_attribution", { scope: "session", session_id: "sess_mcp_1" }, env);
  assert.equal(r.ok, true);
  assert.ok(typeof r.coverage === "number");
  assert.ok(Array.isArray(r.tools));
  assert.ok(Array.isArray(r.notes));
});

test("context_breakdown 在缺少 model-io 时返回可判别错误", async () => {
  const r = await callTool("spend_context_breakdown", { session_id: "sess_mcp_1" }, env);
  assert.equal(r.ok, false);
  assert.equal(r.error, "model-io-not-found");
});

test("advisor 工具返回建议列表且不抛异常", async () => {
  const r = await callTool("spend_advisor", { scope: "session", session_id: "sess_mcp_1" }, env);
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.findings));
  assert.ok(r.ledger);
});

test("top 参数被钳制在合理范围", async () => {
  const r = await callTool("spend_summary", { scope: "session", session_id: "sess_mcp_1", top: 99999 }, env);
  assert.ok(r.dimensions.querySource.length <= 100);
});
