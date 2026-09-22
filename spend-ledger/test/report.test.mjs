// 端到端测试：在真实 schema 的临时库上跑完整报告链路（SQL → 定价 → 归因 → 渲染）。
// 这里的数据是精心构造的，因此每个断言都能手算验证。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureHome, insertSession, insertRequest, insertTool, insertPart, insertTurn, writeSnapshot, TEST_RATES, WS_DIR } from "../test-support/fixture.mjs";
import { buildReport } from "../src/report.mjs";
import { renderReport } from "../src/view.mjs";
import { createTranslator, detectLocale } from "../src/i18n.mjs";

let home;
let env;
let snapshotPath;

before(() => {
  const fx = createFixtureHome();
  home = fx.home;
  const db = fx.db;
  const S = "sess_test_1";
  const T = "turn_1";

  insertSession(db, { id: S, dir: WS_DIR });

  // 三轮请求，每轮之间夹一次工具调用
  insertRequest(db, { id: "r1", sessionId: S, turnId: T, startedAt: 1000, completedAt: 1500, inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0 });
  insertTool(db, { sessionId: S, turnId: T, toolCallId: "call_bash", toolName: "Bash", outputBytes: 3000, startedAt: 1600, completedAt: 1700 });
  insertPart(db, { callId: "call_bash", sessionId: S, tool: "Bash", command: "ls -la", outputChars: 3000, at: 1600 });

  insertRequest(db, { id: "r2", sessionId: S, turnId: T, startedAt: 2000, completedAt: 2500, inputTokens: 5000, outputTokens: 200, cacheReadInputTokens: 3000 });
  insertTool(db, { sessionId: S, turnId: T, toolCallId: "call_read", toolName: "Read", outputBytes: 1000, startedAt: 2600, completedAt: 2700 });
  insertPart(db, { callId: "call_read", sessionId: S, tool: "Read", filePath: "D:/ws/src/a.ts", outputChars: 1000, at: 2600 });

  insertRequest(db, { id: "r3", sessionId: S, turnId: T, startedAt: 3000, completedAt: 3500, inputTokens: 8000, outputTokens: 150, cacheReadInputTokens: 6000 });

  insertTurn(db, { sessionId: S, turnId: T, startedAt: 1000, completedAt: 3600, modelRequestCount: 3, toolCallCount: 2, inputTokens: 14000, outputTokens: 450 });

  // 第二个会话：使用无定价模型，且来源为副代理
  const S2 = "sess_test_2";
  insertSession(db, { id: S2, dir: WS_DIR, title: "sub" });
  insertRequest(db, { id: "r4", sessionId: S2, turnId: "turn_2", startedAt: 5000, completedAt: 5500, inputTokens: 1000, outputTokens: 100, modelId: "unknown-model", querySource: "subagent", agent: "zcode-Explore" });
  insertTurn(db, { sessionId: S2, turnId: "turn_2", startedAt: 5000, modelRequests: 1 });

  const snapDir = mkdtempSync(join(tmpdir(), "spend-snap-"));
  snapshotPath = writeSnapshot(snapDir, TEST_RATES);
  env = { ...process.env, ZCODE_HOME: home, ZCODE_PLUGIN_DATA: join(home, "plugin-data") };
});

after(() => {
  /* 临时目录由系统回收 */
});

test("总账：请求数、token 分类与费用可手算核对", () => {
  const rep = buildReport({ scope: "all", env, snapshotPath });
  assert.equal(rep.ok, true);
  assert.equal(rep.totals.requests, 4);

  // fresh: r1 1000, r2 5000−3000=2000, r3 8000−6000=2000, r4 1000 → 6000
  assert.equal(rep.totals.fresh, 6000);
  assert.equal(rep.totals.cacheRead, 9000);
  assert.equal(rep.totals.output, 550);

  // r1 0.0012 + r2 0.0027 + r3 0.0029 + r4 未定价 0 = 0.0068
  assert.equal(Number(rep.totals.cost.toFixed(6)), 0.0068);

  // 缓存读取占比 9000 / 15000
  assert.equal(Number(rep.totals.cacheReadShare.toFixed(4)), 0.6);
});

test("维度归因把副代理单独拆出", () => {
  const rep = buildReport({ scope: "all", env, snapshotPath });
  const bySource = Object.fromEntries(rep.dimensions.querySource.map((r) => [r.key, r]));
  assert.equal(bySource.main_turn.requests, 3);
  assert.equal(bySource.subagent.requests, 1);
  assert.equal(Number(bySource.subagent.shareInput.toFixed(4)), Number((1000 / 15000).toFixed(4)));

  const byAgent = Object.fromEntries(rep.dimensions.agent.map((r) => [r.key, r]));
  assert.ok(byAgent["zcode-Explore"], "副代理应作为独立代理维度出现");
});

test("未定价模型被显式列出，而不是静默按 0 计费", () => {
  const rep = buildReport({ scope: "all", env, snapshotPath });
  const note = rep.notes.find((n) => n.code === "unpriced");
  assert.ok(note, "应产生未定价说明");
  assert.deepEqual(note.models, ["unknown-model"]);
  assert.equal(rep.totals.unpricedRequests, 1);
});

test("归因：覆盖率与工具/文件分摊可手算核对", () => {
  const rep = buildReport({ scope: "all", env, snapshotPath });
  const a = rep.attribution;

  // turn_1 增长 8000−1000 = 7000
  assert.equal(a.growth, 7000);
  // k=1: 4000−100 = 3900 给 Bash；k=2: 3000−200 = 2800 给 Read
  assert.equal(a.attributed, 6700);
  assert.equal(a.assistantCarry, 300);
  assert.equal(a.residual, 0);
  assert.equal(Number(a.coverage.toFixed(4)), Number((6700 / 7000).toFixed(4)));

  const byTool = Object.fromEntries(a.tools.map((r) => [r.key, r]));
  assert.equal(byTool.Bash.tokens, 3900);
  assert.equal(byTool.Read.tokens, 2800);
  assert.equal(byTool.Bash.cost.toFixed(6), (3900 * 1e-6).toFixed(6), "新增内容按新增输入单价计价");

  assert.equal(a.files.length, 1);
  assert.equal(a.files[0].key, "D:/ws/src/a.ts");
  assert.equal(a.files[0].tokens, 2800);
});

test("缓存包含关系说明始终出现（防止读者误用 input_tokens）", () => {
  const rep = buildReport({ scope: "all", env, snapshotPath });
  assert.ok(rep.notes.some((n) => n.code === "cache-inclusive"));
  const share = rep.notes.find((n) => n.code === "cache-share");
  assert.ok(share, "缓存占比显著时必须提示高估倍数");
  assert.equal(Number(share.factor), Number((1 / 0.4).toFixed(1)));
});

test("会话范围只统计该会话", () => {
  const rep = buildReport({ scope: "session", sessionId: "sess_test_1", env, snapshotPath });
  assert.equal(rep.totals.requests, 3);
  assert.equal(rep.scope.sessionCount, 1);
});

test("时间范围过滤生效", () => {
  const rep = buildReport({ scope: "all", since: 4000, env, snapshotPath });
  assert.equal(rep.totals.requests, 1, "只有 r4 在 4000ms 之后");
});

test("doctor 在夹具库上全绿", async () => {
  const { runDoctor } = await import("../src/cli.mjs");
  const { checks } = runDoctor(env);
  const byName = Object.fromEntries(checks.map((c) => [c.id, c]));
  assert.ok(byName["usage-db"], "检查项应使用稳定的 id");
  assert.equal(byName["usage-db"].status, "ok");
  assert.equal(byName["open-mode"].status, "ok", "夹具库应能以 readOnly 直连打开");
  assert.equal(byName.json1.status, "ok");
  assert.equal(byName["unpriced-models"].status, "warn", "unknown-model 无定价，应被标出");
  assert.match(byName["unpriced-models"].detail, /unknown-model/);
});

test("文本渲染包含关键区块且不抛异常", () => {
  const rep = buildReport({ scope: "all", env, snapshotPath });
  const t = createTranslator("zh-CN");
  const text = renderReport(rep, t);
  assert.match(text, /用量与成本报告/);
  assert.match(text, /按请求来源/);
  assert.match(text, /按工具/);
  assert.match(text, /未定价|无定价/);
  assert.ok(!text.includes("[object Object]"), "渲染不应出现对象字面量");
});

test("英文渲染可用", () => {
  const rep = buildReport({ scope: "all", env, snapshotPath });
  const text = renderReport(rep, createTranslator("en"));
  assert.match(text, /Usage and cost report/);
  assert.match(text, /Fresh input/);
});

test("locale 解析：优先显式设置，识别不了才往下走，最后回退中文", () => {
  assert.equal(detectLocale({ SPEND_LEDGER_LANG: "en" }, null), "en");
  assert.equal(detectLocale({ SPEND_LEDGER_LANG: "zh-TW" }, null), "zh-CN");
  assert.equal(detectLocale({}, { locale: "zh-CN" }), "zh-CN");
  assert.equal(detectLocale({ LANG: "en_US.UTF-8" }, {}), "en");
  assert.equal(detectLocale({}, {}), "zh-CN", "无法判断时按产品母语默认中文");
});

test("locale 解析：模式词与中性 locale 不得把界面变成英文", () => {
  // localePreference 是模式词（"system"）而不是语言代码，必须跳过它继续看 locale。
  // 早先的实现把它当成无法识别后硬判成英文，导致中文安装环境下全英文输出。
  assert.equal(detectLocale({}, { localePreference: "system", locale: "zh-CN" }), "zh-CN");
  assert.equal(detectLocale({}, { localePreference: "system", locale: "en-US" }), "en");
  // LANG=C.UTF-8 这类中性值同样不应被当成英文
  assert.equal(detectLocale({ LANG: "C.UTF-8" }, {}), "zh-CN");
  assert.equal(detectLocale({ LANG: "C", LC_ALL: "POSIX" }, null), "zh-CN");
  // 但真正的英文环境仍要识别出来
  assert.equal(detectLocale({ LANG: "C.UTF-8", LC_ALL: "en_GB.UTF-8" }, {}), "en");
  // 显式设置优先级最高，能覆盖设置文件
  assert.equal(detectLocale({ SPEND_LEDGER_LANG: "en" }, { locale: "zh-CN" }), "en");
});

test("空范围不抛异常，返回可读提示", () => {
  const rep = buildReport({ scope: "session", sessionId: "sess_不存在", env, snapshotPath });
  const text = renderReport(rep, createTranslator("zh-CN"));
  assert.ok(typeof text === "string" && text.length > 0);
});

test("成分分析挑主会话而不是副代理会话", async () => {
  const { pickCompositionSession } = await import("../src/report.mjs");
  // 副代理会话工具集不同、生命周期短，取最新一条容易落到它上面，结论就不可比
  const rep = {
    ok: true,
    scope: {
      sessionId: null,
      sessions: [
        { id: "sess_subagent_agent_x" },
        { id: "sess_main_new" },
        { id: "sess_main_old" },
      ],
    },
  };
  assert.equal(pickCompositionSession(rep), "sess_main_new", "应跳过 sess_subagent_* 取最新的主会话");

  // 明确指定会话时必须尊重指定，不做替换
  assert.equal(pickCompositionSession({ ...rep, scope: { ...rep.scope, sessionId: "sess_x" } }), "sess_x");

  // 只有副代理会话时退而用之，而不是返回 null
  assert.equal(pickCompositionSession({ ok: true, scope: { sessionId: null, sessions: [{ id: "sess_subagent_agent_y" }] } }), "sess_subagent_agent_y");

  assert.equal(pickCompositionSession({ ok: false }), null);
});

test("工作区过滤兼容正反斜杠与大小写（Windows 路径归一化）", () => {
  // 库里存的是反斜杠，调用方通常传正斜杠，必须都能命中
  for (const ws of [WS_DIR, "D:/ws", "d:/WS/", WS_DIR + "\\"]) {
    const rep = buildReport({ scope: "workspace", workspace: ws, env, snapshotPath });
    assert.equal(rep.totals.requests, 4, `工作区 ${ws} 应命中全部 4 条请求`);
    assert.equal(rep.scope.sessionCount, 2);
  }
});

test("会话作用域能通过工作区解析出最新会话", () => {
  const rep = buildReport({ scope: "session", workspace: "D:/ws", env, snapshotPath });
  assert.ok(rep.scope.sessionId, "应解析出具体会话");
  assert.equal(rep.scope.kind, "session");
});

test("解析不到会话时如实标注为全量，而不是谎称本次会话", () => {
  const rep = buildReport({ scope: "session", workspace: "D:/不存在的目录", env, snapshotPath });
  assert.equal(rep.scope.kind, "all");
  assert.equal(rep.scope.requestedKind, "session");
  assert.equal(rep.scope.fallbackReason, "no-session-resolved-for-cwd");
});
