// 手写 MCP 服务：零第三方依赖，stdio 上是换行分隔的 JSON-RPC 2.0。
// 之所以不引 @modelcontextprotocol/server：插件安装期不会执行 npm install，
// 任何第三方依赖都得自己打包；这是个只有几百行的协议子集，不值得背依赖。
//
// 协议要点：stdout 只能出现 JSON-RPC 消息，日志一律走 stderr。
import { createInterface } from "node:readline";
import { buildReport } from "./report.mjs";
import { analyzeComposition } from "./composition.mjs";
import { advise } from "./advisor.mjs";
import { ledgerStatus } from "./ledger.mjs";

export const SERVER_INFO = { name: "spend-ledger", version: "0.1.0" };
export const PROTOCOL_FALLBACK = "2024-11-05";

const SCOPE_PROP = {
  type: "string",
  enum: ["session", "workspace", "all"],
  description: "统计范围。session=当前或指定会话；workspace=当前工作区全部会话；all=全部历史。默认 session。",
};

export const TOOLS = [
  {
    name: "spend_summary",
    description:
      "ZCode 用量与成本总账：请求数、新增输入/缓存读取/输出 token、费用，以及按请求来源（主会话/副代理/标题生成）、代理、模式、模型的分解。全部数据只读本地 SQLite，不联网。",
    inputSchema: {
      type: "object",
      properties: {
        scope: SCOPE_PROP,
        session_id: { type: "string", description: "指定会话 id（sess_...）" },
        workspace: { type: "string", description: "工作区目录，默认取当前目录" },
        since: { type: "string", description: "起始时间，支持 7d / 24h / ISO 日期" },
      },
    },
  },
  {
    name: "spend_attribution",
    description:
      "把 token 增长归因到具体工具与文件，并给出归因覆盖率。采用增量归因模型（同一轮内相邻请求的上下文增量，扣除助手自身输出后按输出体量分摊给工具），因此结果带覆盖率指标而非精确值。",
    inputSchema: {
      type: "object",
      properties: {
        scope: SCOPE_PROP,
        session_id: { type: "string" },
        workspace: { type: "string" },
        since: { type: "string" },
        top: { type: "integer", description: "返回条数，默认 15" },
      },
    },
  },
  {
    name: "spend_context_breakdown",
    description:
      "上下文成分分析：把每轮输入拆成系统提示、工具 schema（含按 MCP 服务器细分）、历史消息，给出每轮固定开销与会话累计。静态部分逐条精确可算；历史为残差。需要该会话有 model-io 记录。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "会话 id；省略则取当前工作区最近一个会话" },
        workspace: { type: "string" },
        max_requests: { type: "integer", description: "只分析最近 N 个请求，0 或省略为全部" },
      },
    },
  },
  {
    name: "spend_advisor",
    description:
      "给出可执行的降本建议：每轮固定开销过高的 MCP 服务器、从未被调用的 MCP 工具、重复读取的文件、上下文膨胀、重试与超上下文浪费等。每条建议都带证据与可省估算（估算值）。",
    inputSchema: {
      type: "object",
      properties: {
        scope: SCOPE_PROP,
        session_id: { type: "string" },
        workspace: { type: "string" },
        since: { type: "string" },
        top: { type: "integer", description: "返回条数，默认 8" },
      },
    },
  },
];

function compactReport(rep, top) {
  if (!rep.ok) return rep;
  const { requests, ...rest } = rep;
  return {
    ...rest,
    scope: { ...rep.scope, sessions: rep.scope.sessions?.slice(0, 10) },
    dimensions: Object.fromEntries(Object.entries(rep.dimensions).map(([k, v]) => [k, v.slice(0, top)])),
    toolsByBytes: rep.toolsByBytes?.slice(0, top),
    mcpServers: rep.mcpServers?.slice(0, top),
    attribution: rep.attribution
      ? { ...rep.attribution, tools: rep.attribution.tools.slice(0, top), files: rep.attribution.files.slice(0, top), shrinkEvents: rep.attribution.shrinkEvents.slice(0, 5) }
      : null,
  };
}

export async function callTool(name, args = {}, env = process.env) {
  const scopeArgs = {
    scope: args.scope ?? "session",
    sessionId: args.session_id,
    workspace: args.workspace ?? env.ZCODE_PROJECT_DIR ?? process.cwd(),
    since: args.since,
    env,
  };
  const top = Math.min(Math.max(Number(args.top) || 15, 1), 100);

  switch (name) {
    case "spend_summary":
      return compactReport(buildReport(scopeArgs), top);

    case "spend_attribution": {
      const rep = buildReport(scopeArgs);
      if (!rep.ok) return rep;
      return {
        ok: true,
        scope: { kind: rep.scope.kind, sessionId: rep.scope.sessionId, sessionCount: rep.scope.sessionCount },
        coverage: rep.attribution.coverage,
        growth: rep.attribution.growth,
        attributed: rep.attribution.attributed,
        assistantCarry: rep.attribution.assistantCarry,
        residual: rep.attribution.residual,
        shrinkTokens: rep.attribution.shrinkTokens,
        shrinkCount: rep.attribution.shrinkEvents.length,
        tools: rep.attribution.tools.slice(0, top),
        files: rep.attribution.files.slice(0, top),
        mcpServers: rep.mcpServers?.slice(0, top),
        toolsByBytes: rep.toolsByBytes?.slice(0, top),
        notes: rep.notes,
      };
    }

    case "spend_context_breakdown": {
      let sessionId = args.session_id ?? null;
      if (!sessionId) {
        const rep = buildReport({ ...scopeArgs, scope: "session" });
        sessionId = rep.ok ? rep.scope.sessionId ?? rep.scope.sessions?.[0]?.id ?? null : null;
      }
      if (!sessionId) return { ok: false, error: "no-session-in-scope" };
      const comp = await analyzeComposition({ sessionId, env, maxRequests: args.max_requests ?? 0 });
      if (!comp.ok) return comp;
      return {
        ok: true,
        sessionId: comp.sessionId,
        requestCount: comp.requestCount,
        calibration: comp.calibration,
        aggregate: {
          ...comp.aggregate,
          mcpServers: comp.aggregate.mcpServers.slice(0, top),
          historyBreakdown: comp.aggregate.historyBreakdown
            ? { ...comp.aggregate.historyBreakdown, perRequest: round(comp.aggregate.historyBreakdown.perRequest) }
            : null,
        },
        warnings: comp.warnings,
        assumptions: comp.assumptions,
      };
    }

    case "spend_advisor": {
      const rep = buildReport(scopeArgs);
      if (!rep.ok) return rep;
      const sid = rep.scope.sessionId ?? rep.scope.sessions?.[0]?.id ?? null;
      const comp = sid ? await analyzeComposition({ sessionId: sid, env }) : null;
      const result = advise(rep, comp);
      return { ...result, findings: result.findings.slice(0, top), ledger: ledgerStatus(env) };
    }

    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

function round(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Math.round(v)]));
}

// ---- JSON-RPC 循环 ----

export function handleMessage(msg, env = process.env) {
  const { id, method, params } = msg ?? {};
  // 通知（无 id）不需要回复
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_FALLBACK,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      return callTool(name, args, env).then(
        (result) => reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] }),
        (err) => reply(id, { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err?.message ?? err) }) }], isError: true })
      );
    }
    default:
      if (isNotification) return null;
      return replyErr(id, -32601, `Method not found: ${method}`);
  }
}

function reply(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function replyErr(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function serve({ input = process.stdin, output = process.stdout, env = process.env } = {}) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      output.write(JSON.stringify(replyErr(null, -32700, "Parse error")) + "\n");
      return;
    }
    try {
      const res = await handleMessage(msg, env);
      if (res) output.write(JSON.stringify(res) + "\n");
    } catch (err) {
      output.write(JSON.stringify(replyErr(msg?.id ?? null, -32603, String(err?.message ?? err))) + "\n");
    }
  });
  return rl;
}
