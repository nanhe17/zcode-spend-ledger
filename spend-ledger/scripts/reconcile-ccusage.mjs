// 对账：与独立实现（ccusage 的 ZCode 适配器）比较 token 口径。
//
// 为什么要做这件事：token 列是可以精确对账的，而成本不能——上游没有成本列，
// 各家定价表不同。因此本脚本比较 token 与请求数，并把成本差异明确归因。
//
// 用法：node scripts/reconcile-ccusage.mjs [--month 2026-09] [--no-run]
import { execFileSync } from "node:child_process";
import { buildReport, parseSince } from "../src/report.mjs";
import { openUsageDb } from "../src/db.mjs";
import { fmtTokens, fmtUsd } from "../src/render.mjs";

const args = process.argv.slice(2);
const monthIdx = args.indexOf("--month");
const month = monthIdx > -1 ? args[monthIdx + 1] : null;
const noRun = args.includes("--no-run");

// 本插件的口径
const conn = openUsageDb({});
const period = month
  ? { since: Date.parse(`${month}-01T00:00:00Z`), until: Date.parse(monthEnd(month)) }
  : {};
const rep = buildReport({ scope: "all", conn, ...period });
conn.close();

function monthEnd(m) {
  const [y, mm] = m.split("-").map(Number);
  return new Date(Date.UTC(mm === 12 ? y + 1 : y, mm === 12 ? 0 : mm, 1)).toISOString();
}

const ours = {
  requests: rep.totals.requests,
  input: rep.totals.fresh,
  cacheRead: rep.totals.cacheRead,
  cacheWrite: rep.totals.cacheWrite,
  output: rep.totals.output,
  cost: rep.totals.cost,
  unpriced: rep.notes.find((n) => n.code === "unpriced")?.models ?? [],
};

let theirs = null;
let theirError = null;
if (!noRun) {
  try {
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    const raw = execFileSync(npx, ["-y", "ccusage@latest", "zcode", month ? "monthly" : "session", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    const parsed = JSON.parse(raw);
    theirs = month ? (parsed.monthly?.find((m) => m.month === month) ?? parsed.totals) : parsed.totals;
  } catch (err) {
    theirError = String(err.message).slice(0, 400);
  }
}

const pct = (a, b) => (b ? (((a - b) / b) * 100).toFixed(2) + "%" : "n/a");

console.log("=== spend-ledger ===");
console.log(`  period        ${month ?? "all"}`);
console.log(`  requests      ${ours.requests}`);
console.log(`  fresh input   ${ours.input.toLocaleString()}  (${fmtTokens(ours.input)})`);
console.log(`  cache read    ${ours.cacheRead.toLocaleString()}  (${fmtTokens(ours.cacheRead)})`);
console.log(`  output        ${ours.output.toLocaleString()}  (${fmtTokens(ours.output)})`);
console.log(`  cost          ${fmtUsd(ours.cost)}`);
console.log(`  unpriced      ${ours.unpriced.length ? ours.unpriced.join(", ") : "(none)"}`);

if (theirs) {
  console.log("\n=== ccusage (independent implementation) ===");
  console.log(`  inputTokens   ${theirs.inputTokens.toLocaleString()}`);
  console.log(`  cacheRead     ${theirs.cacheReadTokens.toLocaleString()}`);
  console.log(`  outputTokens  ${theirs.outputTokens.toLocaleString()}`);
  console.log(`  totalTokens   ${theirs.totalTokens.toLocaleString()}`);
  console.log(`  totalCost     ${fmtUsd(theirs.totalCost)}`);
  console.log(`  unpriced      ${(theirs.unpricedModels ?? []).join(", ") || "(none)"}`);

  console.log("\n=== delta (spend-ledger vs ccusage) ===");
  console.log(`  fresh input   ${pct(ours.input, theirs.inputTokens)}`);
  console.log(`  cache read    ${pct(ours.cacheRead, theirs.cacheReadTokens)}`);
  console.log(`  output        ${pct(ours.output, theirs.outputTokens)}`);
  console.log(`  cost          ${fmtUsd(ours.cost)} vs ${fmtUsd(theirs.totalCost)}`);

  const tol = 0.05;
  const worst = Math.max(
    Math.abs(ours.input / theirs.inputTokens - 1),
    Math.abs(ours.cacheRead / theirs.cacheReadTokens - 1),
    Math.abs(ours.output / theirs.outputTokens - 1)
  );
  console.log(`\n  verdict       ${worst <= tol ? "PASS" : "FAIL"} (max token delta ${(worst * 100).toFixed(2)}%, tolerance ${tol * 100}%)`);
  console.log(`  note          ccusage 对这四个模型均无定价，故 totalCost 为 0；本插件给出 ${fmtUsd(ours.cost)}。`);
} else {
  console.log("\nccusage 未运行或失败：" + (theirError ?? "skipped"));
}
