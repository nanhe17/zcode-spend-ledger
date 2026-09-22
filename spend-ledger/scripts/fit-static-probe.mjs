// 实验（开发工具）：验证「input_tokens = 静态 + b × 消息加权长度」是否成立，
// 并看拟合出的静态值能否对上 ZCode 内置「上下文容量」面板的数字。
//
// 模型为什么成立：system 与 tools 在同一会话的每条请求里完全一致
// （实测 82 条记录恒定 7,804 / 133,492 字符），所以它们的贡献是一个常数项。
// 用 messagesKind=full 的记录（消息完整）对 input_tokens 做两参数最小二乘，
// 截距即静态 token 数，斜率即消息的 token 密度——不需要分词器。
//
// 用法：node scripts/fit-static-probe.mjs [sessionId]
import { createReadStream, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { zcodePaths } from "../src/paths.mjs";
import { weightedLength } from "../src/composition.mjs";

const only = process.argv[2] ?? null;
const rollout = zcodePaths({}).rolloutDir;
const files = readdirSync(rollout)
  .filter((f) => f.startsWith("model-io-"))
  .filter((f) => !only || f.includes(only));

function lsq(points) {
  const n = points.length;
  const sx = points.reduce((a, p) => a + p.x, 0);
  const sy = points.reduce((a, p) => a + p.y, 0);
  const sxx = points.reduce((a, p) => a + p.x * p.x, 0);
  const sxy = points.reduce((a, p) => a + p.x * p.y, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const b = (n * sxy - sx * sy) / denom;
  const c = (sy - b * sx) / n;
  const ybar = sy / n;
  const ssTot = points.reduce((a, p) => a + (p.y - ybar) ** 2, 0);
  const ssRes = points.reduce((a, p) => a + (p.y - (c + b * p.x)) ** 2, 0);
  return { c, b, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot, n };
}

for (const file of files) {
  const records = [];
  const rl = createInterface({ input: createReadStream(join(rollout, file)), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* 跳过坏行 */
    }
  }

  const session = file.replace("model-io-", "").replace(".jsonl", "");
  const pts = [];
  let staticWeighted = 0;
  for (const rec of records) {
    if (rec.request?.messagesKind !== "full") continue;
    const body = rec.request?.body ?? {};
    staticWeighted =
      (body.system ?? []).reduce((a, s) => a + weightedLength(s?.text ?? "").weighted, 0) +
      (body.tools ?? []).reduce((a, t) => a + weightedLength(JSON.stringify(t)).weighted, 0);
    const msgWeighted = (rec.request?.messages ?? []).reduce((a, m) => {
      const t = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
      return a + weightedLength(t).weighted;
    }, 0);
    pts.push({ x: msgWeighted, y: rec.response?.usage?.inputTokens ?? 0 });
  }

  console.log(`\n${session}`);
  if (pts.length < 3) {
    console.log(`  full 记录 ${pts.length} 条，不足以拟合（需要 ≥3）`);
    continue;
  }
  const fit = lsq(pts);
  if (!fit) {
    console.log("  消息长度无变化，无法分离两个参数");
    continue;
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  console.log(`  full 记录 ${pts.length} 条 · 消息加权长度 ${Math.min(...xs).toFixed(0)}..${Math.max(...xs).toFixed(0)}`);
  console.log(`  input_tokens ${Math.min(...ys).toLocaleString()}..${Math.max(...ys).toLocaleString()}`);
  console.log(`  拟合  静态 = ${fit.c.toFixed(0)} token · 消息密度 ${fit.b.toFixed(4)} token/加权字符 · R² = ${fit.r2.toFixed(4)}`);
  console.log(`  system+tools 加权长度 = ${staticWeighted.toFixed(0)} → 静态密度 ${(fit.c / staticWeighted).toFixed(4)} token/加权字符`);
  const residuals = pts.map((p) => p.y - (fit.c + fit.b * p.x));
  const maxRes = Math.max(...residuals.map(Math.abs));
  console.log(`  最大残差 ${maxRes.toFixed(0)} token (${((maxRes / ys[0]) * 100).toFixed(1)}%)`);
  console.log(`  对照：单一全局密度估算给出的静态 = ${(staticWeighted * 1.1512).toFixed(0)} token`);
}
