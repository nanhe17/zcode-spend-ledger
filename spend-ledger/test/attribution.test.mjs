// 归因引擎测试：验证增量归因的分配、助手输出的扣除、压缩事件的识别与覆盖率口径。
import { test } from "node:test";
import assert from "node:assert/strict";
import { attributeIncrementally, summarize, rollupBy, mcpServerOf, rollupMcpServers, rollupToolsByBytes } from "../src/attribution.mjs";

// 构造 priced 行：{row, price}
function P(row, over = {}) {
  const fresh = Math.max(0, row.input_tokens - (row.cache_read_input_tokens ?? 0) - (row.cache_creation_input_tokens ?? 0));
  return {
    row,
    price: {
      priced: true,
      fresh,
      cacheRead: row.cache_read_input_tokens ?? 0,
      cacheWrite: row.cache_creation_input_tokens ?? 0,
      output: row.output_tokens ?? 0,
      costFresh: fresh * 1e-6,
      costCacheRead: (row.cache_read_input_tokens ?? 0) * 1e-7,
      costCacheWrite: 0,
      costOutput: (row.output_tokens ?? 0) * 2e-6,
      total: fresh * 1e-6 + (row.cache_read_input_tokens ?? 0) * 1e-7 + (row.output_tokens ?? 0) * 2e-6,
      assumptions: [],
      ...over,
    },
  };
}

const rateForRow = () => 1e-6;

test("增量按 output_bytes 加权分摊给窗口内的工具", () => {
  const priced = [
    P({ session_id: "s", turn_id: "t1", started_at: 1000, completed_at: 1500, input_tokens: 1000, output_tokens: 100 }),
    P({ session_id: "s", turn_id: "t1", started_at: 2000, completed_at: 2500, input_tokens: 5000, output_tokens: 200 }),
  ];
  const tools = [
    { session_id: "s", turn_id: "t1", tool_call_id: "c1", tool_name: "Bash", output_bytes: 3000, started_at: 1600, completed_at: 1700 },
    { session_id: "s", turn_id: "t1", tool_call_id: "c2", tool_name: "Read", output_bytes: 1000, started_at: 1750, completed_at: 1800 },
  ];
  const a = attributeIncrementally(priced, tools, { rateForRow });
  // delta = 4000，助手输出 100 进入下一轮上下文，可归因 3900
  assert.equal(a.attributed, 3900);
  assert.equal(a.assistantCarry, 100);
  const byTool = Object.fromEntries(a.tools.map((t) => [t.key, t.tokens]));
  assert.equal(Number(byTool.Bash.toFixed(6)), 2925, "按 3:1 权重分摊 3900");
  assert.equal(Number(byTool.Read.toFixed(6)), 975);
});

test("助手自身输出从增量中扣除，不计入工具开销", () => {
  const priced = [
    P({ session_id: "s", turn_id: "t1", started_at: 1000, completed_at: 1100, input_tokens: 1000, output_tokens: 900 }),
    P({ session_id: "s", turn_id: "t1", started_at: 2000, completed_at: 2100, input_tokens: 1500, output_tokens: 50 }),
  ];
  const tools = [{ session_id: "s", turn_id: "t1", tool_call_id: "c1", tool_name: "Read", output_bytes: 10, started_at: 1150, completed_at: 1200 }];
  const a = attributeIncrementally(priced, tools, { rateForRow });
  // delta = 500，助手上一轮输出 900 > 500 → 全部记为 carry，工具不该拿到任何 token
  assert.equal(a.attributed, 0);
  assert.equal(a.tools.length, 0);
});

test("负增量记为压缩事件，不做分摊", () => {
  const priced = [
    P({ session_id: "s", turn_id: "t1", started_at: 1000, completed_at: 1100, input_tokens: 90000, output_tokens: 100 }),
    P({ session_id: "s", turn_id: "t1", started_at: 2000, completed_at: 2100, input_tokens: 20000, output_tokens: 100 }),
  ];
  const tools = [{ session_id: "s", turn_id: "t1", tool_call_id: "c1", tool_name: "Read", output_bytes: 10, started_at: 1150, completed_at: 1200 }];
  const a = attributeIncrementally(priced, tools, { rateForRow });
  assert.equal(a.shrinkEvents.length, 1);
  assert.equal(a.shrinkEvents[0].tokens, 70000);
  assert.equal(a.attributed, 0);
  assert.equal(a.growth, 0, "整体回退时不产生正增长");
});

test("窗口内没有工具时增量计入 residual，不硬塞给任何工具", () => {
  const priced = [
    P({ session_id: "s", turn_id: "t1", started_at: 1000, completed_at: 1100, input_tokens: 1000, output_tokens: 100 }),
    P({ session_id: "s", turn_id: "t1", started_at: 2000, completed_at: 2100, input_tokens: 3000, output_tokens: 50 }),
  ];
  const a = attributeIncrementally(priced, [], { rateForRow });
  assert.equal(a.attributed, 0);
  assert.equal(a.residual, 1900, "growth 2000 − carry 100");
});

test("覆盖率 = 已归因 / 总增长，且随残差下降", () => {
  const priced = [
    P({ session_id: "s", turn_id: "t1", started_at: 1000, completed_at: 1100, input_tokens: 1000, output_tokens: 0 }),
    P({ session_id: "s", turn_id: "t1", started_at: 2000, completed_at: 2100, input_tokens: 3000, output_tokens: 0 }),
    P({ session_id: "s", turn_id: "t1", started_at: 3000, completed_at: 3100, input_tokens: 9000, output_tokens: 0 }),
  ];
  const tools = [{ session_id: "s", turn_id: "t1", tool_call_id: "c1", tool_name: "Read", output_bytes: 10, started_at: 2100, completed_at: 2200 }];
  const a = attributeIncrementally(priced, tools, { rateForRow });
  // growth = 8000；k=1 增量 2000 无工具 → 残差；k=2 增量 6000 有工具 → 归因
  assert.equal(a.growth, 8000);
  assert.equal(a.attributed, 6000);
  assert.equal(Number(a.coverage.toFixed(4)), 0.75);
});

test("单请求轮次不产生归因（无可比对的增量）", () => {
  const priced = [P({ session_id: "s", turn_id: "t1", started_at: 1000, completed_at: 1100, input_tokens: 5000, output_tokens: 100 })];
  const a = attributeIncrementally(priced, [], { rateForRow });
  assert.equal(a.growth, 0);
  assert.equal(a.coverage, 0);
});

test("文件归因通过 tool_call_id 关联到具体路径", () => {
  const priced = [
    P({ session_id: "s", turn_id: "t1", started_at: 1000, completed_at: 1100, input_tokens: 1000, output_tokens: 0 }),
    P({ session_id: "s", turn_id: "t1", started_at: 2000, completed_at: 2100, input_tokens: 4000, output_tokens: 0 }),
  ];
  const tools = [{ session_id: "s", turn_id: "t1", tool_call_id: "c1", tool_name: "Read", output_bytes: 100, started_at: 1200, completed_at: 1300 }];
  const detailsByCall = new Map([["c1", { tool_call_id: "c1", file_path: "D:/ws/src/a.ts", tool_name: "Read" }]]);
  const a = attributeIncrementally(priced, tools, { rateForRow, detailsByCall });
  assert.equal(a.files.length, 1);
  assert.equal(a.files[0].key, "D:/ws/src/a.ts");
  assert.equal(a.files[0].tokens, 3000);
});

test("summarize 汇总各 token 类别与费用", () => {
  const s = summarize([
    P({ session_id: "s", input_tokens: 1000, cache_read_input_tokens: 800, cache_creation_input_tokens: 100, output_tokens: 50 }),
    P({ session_id: "s", input_tokens: 2000, cache_read_input_tokens: 1500, output_tokens: 100 }),
  ]);
  assert.equal(s.requests, 2);
  assert.equal(s.input, 3000);
  assert.equal(s.fresh, 100 + 500);
  assert.equal(s.cacheRead, 2300);
  assert.equal(s.cacheWrite, 100);
  assert.equal(s.output, 150);
  assert.equal(Number(s.cacheReadShare.toFixed(4)), Number((2300 / 3000).toFixed(4)));
});

test("rollupBy 按维度聚合且份额归一", () => {
  const rows = rollupBy(
    [
      P({ session_id: "s", query_source: "main_turn", input_tokens: 1000, output_tokens: 0 }),
      P({ session_id: "s", query_source: "main_turn", input_tokens: 1000, output_tokens: 0 }),
      P({ session_id: "s", query_source: "subagent", input_tokens: 2000, output_tokens: 0 }),
    ],
    (r) => r.query_source
  );
  const sub = rows.find((r) => r.key === "subagent");
  const main = rows.find((r) => r.key === "main_turn");
  assert.equal(sub.input, 2000);
  assert.equal(main.input, 2000, "两个分组输入量相同");
  assert.equal(Number(sub.shareInput.toFixed(4)), 0.5);
  assert.equal(rows.reduce((a, r) => a + r.shareInput, 0).toFixed(6), "1.000000");
  // 平局时顺序必须确定：按 key 升序 → main_turn 在前
  assert.deepEqual(rows.map((r) => r.key), ["main_turn", "subagent"]);
});

test("MCP 工具名解析：普通命名空间与插件命名空间", () => {
  assert.equal(mcpServerOf("mcp__computer-use__screenshot"), "computer-use");
  assert.equal(mcpServerOf("mcp__plugin_playwright_playwright__browser_navigate"), "playwright");
  assert.equal(mcpServerOf("Bash"), null);
  assert.equal(mcpServerOf("mcp__sequential-thinking__think"), "sequential-thinking");
});

test("MCP 服务器聚合按输出体量排序", () => {
  const tools = [
    { tool_name: "mcp__a__x", output_bytes: 100, duration_ms: 10, tool_call_id: "1" },
    { tool_name: "mcp__a__y", output_bytes: 200, duration_ms: 20, tool_call_id: "2" },
    { tool_name: "mcp__b__z", output_bytes: 50, duration_ms: 5, tool_call_id: "3" },
    { tool_name: "Bash", output_bytes: 9999, duration_ms: 1, tool_call_id: "4" },
  ];
  const rows = rollupMcpServers([], tools);
  assert.equal(rows.length, 2, "非 mcp__ 工具不应进入 MCP 分组");
  assert.equal(rows[0].server, "a");
  assert.equal(rows[0].calls, 2);
  assert.equal(rows[0].outputBytes, 300);
  assert.equal(rows[0].toolCount, 2);
});

test("工具字节汇总统计调用数与错误数", () => {
  const rows = rollupToolsByBytes([
    { tool_name: "Bash", output_bytes: 100, duration_ms: 1, status: "completed", read_only: 0 },
    { tool_name: "Bash", output_bytes: 200, duration_ms: 1, status: "error", read_only: 0 },
    { tool_name: "Read", output_bytes: 50, duration_ms: 1, status: "completed", read_only: 1 },
  ]);
  const bash = rows.find((r) => r.tool === "Bash");
  assert.equal(bash.calls, 2);
  assert.equal(bash.errors, 1);
  assert.equal(bash.outputBytes, 300);
});
