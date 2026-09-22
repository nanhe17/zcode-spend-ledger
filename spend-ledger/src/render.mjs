// 终端渲染：token/金额格式化、表格、颜色。
// 不引第三方依赖；颜色用 ANSI 转义，并尊重 NO_COLOR 与 --no-color。
const useColor = (() => {
  if (process.argv.includes("--no-color")) return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return process.stdout.isTTY === true;
})();

export const c = {
  bold: (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : String(s)),
  dim: (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : String(s)),
  red: (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : String(s)),
  green: (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : String(s)),
  yellow: (s) => (useColor ? `\x1b[33m${s}\x1b[0m` : String(s)),
  cyan: (s) => (useColor ? `\x1b[36m${s}\x1b[0m` : String(s)),
};

export function fmtTokens(v) {
  const n = Number(v) || 0;
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e4) return (n / 1e3).toFixed(1) + "K";
  if (abs >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return Math.round(n).toLocaleString("en-US");
}

export function fmtUsd(v) {
  const n = Number(v) || 0;
  const abs = Math.abs(n);
  if (abs === 0) return "$0";
  if (abs < 0.0001) return "$" + n.toExponential(2);
  if (abs < 0.01) return "$" + n.toFixed(6);
  if (abs < 1) return "$" + n.toFixed(4);
  if (abs < 1000) return "$" + n.toFixed(2);
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtPct(x, digits = 1) {
  return ((Number(x) || 0) * 100).toFixed(digits) + "%";
}

export function fmtBytes(v) {
  const n = Number(v) || 0;
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + "MB";
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(1) + "KB";
  return n + "B";
}

export function fmtMs(v) {
  const n = Number(v) || 0;
  if (n >= 60000) return (n / 60000).toFixed(1) + "m";
  if (n >= 1000) return (n / 1000).toFixed(2) + "s";
  return Math.round(n) + "ms";
}

export function fmtDuration(ms) {
  const n = Number(ms) || 0;
  const h = Math.floor(n / 3600000);
  const m = Math.floor((n % 3600000) / 60000);
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m`;
  return `${Math.round(n / 1000)}s`;
}

// 按显示宽度对齐（中文与 emoji 按 2 列计）
export function width(str) {
  let w = 0;
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    w += cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f9ff)) ? 2 : 1;
  }
  return w;
}

function pad(str, len, align = "left") {
  const s = String(str);
  const gap = Math.max(0, len - width(s));
  return align === "right" ? " ".repeat(gap) + s : s + " ".repeat(gap);
}

/**
 * 渲染表格。
 * @param {Array<{header:string, key:string|Function, align?:'left'|'right', render?:Function}>} columns
 */
export function table(columns, rows, opts = {}) {
  if (!rows.length) return opts.emptyText ?? "";
  const cells = rows.map((r) =>
    columns.map((col) => {
      const raw = typeof col.key === "function" ? col.key(r) : r[col.key];
      return col.render ? col.render(raw, r) : raw == null ? "" : String(raw);
    })
  );
  const widths = columns.map((col, i) => Math.max(width(col.header), ...cells.map((row) => width(row[i]))));
  const lines = [];
  const showHeader = !opts.hideHeader && columns.some((col) => String(col.header ?? "") !== "");
  if (showHeader) {
    lines.push(columns.map((col, i) => c.bold(pad(col.header, widths[i], col.align))).join("  "));
    lines.push(widths.map((w) => c.dim("─".repeat(w))).join("  "));
  }
  for (const row of cells) {
    lines.push(columns.map((col, i) => pad(row[i], widths[i], col.align)).join("  "));
  }
  return lines.join("\n");
}

export function heading(text, level = 1) {
  return level === 1 ? "\n" + c.bold(c.cyan(text)) : "\n" + c.bold(text);
}

export function bullet(text) {
  return "  • " + text;
}

export function quoteLines(text, prefix = "  ") {
  return String(text)
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
}
