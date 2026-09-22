// 插件清单自检：这些是宿主加载插件时会实际检查的项，
// 做成测试后每次改动清单都会立刻暴露问题，而不是等安装失败才发现。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const manifest = readJson(join(ROOT, ".zcode-plugin", "plugin.json"));

test("manifest 名称合法且与目录名一致", () => {
  assert.match(manifest.name, /^[a-z0-9][a-z0-9._-]{0,127}$/);
  assert.equal(manifest.name, "spend-ledger");
  assert.equal(manifest.name, ROOT.split(/[\\/]/).pop(), "目录名必须与 manifest name 一致");
});

test("manifest 必填字段与语义化版本存在", () => {
  assert.equal(typeof manifest.version, "string");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof manifest.description, "string");
  assert.ok(manifest.description.length > 40, "描述应说明实际用途而非占位文本");
  assert.ok(manifest.description_i18n?.["zh-CN"], "中文展示文案应存在（官方市场惯例）");
});

test("声明为字符串路径的组件都必须真实存在且落在插件根目录内", () => {
  const stringPathComponents = ["skills", "commands", "hooks"];
  for (const key of stringPathComponents) {
    const value = manifest[key];
    if (value == null) continue;
    assert.equal(typeof value, "string");
    const abs = resolve(ROOT, value);
    assert.ok(abs.startsWith(ROOT + sep) || abs === ROOT, `${key} 路径不得越出插件根目录`);
    assert.ok(existsSync(abs), `${key} 指向的路径不存在：${value}`);
  }
});

test("mcpServers 指向的配置存在，且条目字段合法", () => {
  const ref = manifest.mcpServers;
  assert.equal(typeof ref, "string");
  const file = resolve(ROOT, ref);
  assert.ok(existsSync(file), `缺少 MCP 配置：${ref}`);
  const cfg = readJson(file);
  assert.ok(cfg.mcpServers && Object.keys(cfg.mcpServers).length > 0);
  for (const [name, server] of Object.entries(cfg.mcpServers)) {
    assert.equal(server.type, "stdio", `${name} 应为 stdio`);
    assert.equal(server.command, "node");
    assert.ok(Array.isArray(server.args) && server.args.length > 0);
    // MCP 服务拿不到插件根目录变量，必须由 args 显式传递
    assert.match(server.args.join(" "), /\$\{(CLAUDE|ZCODE)_PLUGIN_ROOT\}/, `${name} 必须用模板变量定位入口文件`);
    const entry = server.args.join(" ").match(/\$\{(?:CLAUDE|ZCODE)_PLUGIN_ROOT\}\/([^"]+)/);
    if (entry) {
      assert.ok(existsSync(join(ROOT, entry[1])), `MCP 入口文件不存在：${entry[1]}`);
    }
  }
});

test("userConfig 声明的键都有默认值", () => {
  for (const [key, spec] of Object.entries(manifest.userConfig ?? {})) {
    assert.ok(spec.type, `${key} 缺少 type`);
    assert.ok(spec.default !== undefined, `${key} 缺少 default`);
  }
});

test("命令名与目录结构一致（spend/foo.md → /spend:foo）", () => {
  const dir = join(ROOT, manifest.commands);
  const names = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const rel = join(entry.parentPath ?? entry.path, entry.name).slice(dir.length + 1).replace(/\\/g, "/");
    names.push("/" + rel.replace(/\.md$/, "").replace(/\//g, ":"));
  }
  assert.deepEqual(names.sort(), ["/spend:advise", "/spend:composition", "/spend:doctor", "/spend:report"]);
});

test("每个命令都有 description 前置元数据（决定它能否被发现）", () => {
  const dir = join(ROOT, manifest.commands);
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const body = readFileSync(join(entry.parentPath ?? entry.path, entry.name), "utf8");
    assert.match(body, /^---\n[\s\S]*?description:/, `${entry.name} 缺少 description`);
  }
});

test("技能目录里每个 SKILL.md 都有 name 与 description", () => {
  const dir = join(ROOT, manifest.skills);
  let found = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "SKILL.md");
    assert.ok(existsSync(file), `${entry.name} 缺少 SKILL.md`);
    const body = readFileSync(file, "utf8");
    const name = body.match(/^---\n(?:.*\n)*?name:\s*(.+)$/m)?.[1]?.trim();
    const desc = body.match(/^---\n(?:.*\n)*?description:\s*(.+)$/m)?.[1]?.trim();
    assert.equal(name, entry.name, "SKILL.md 的 name 必须与目录名一致");
    assert.ok(desc && desc.length > 20, "description 决定能否被正确路由，必须写清触发场景");
    found++;
  }
  assert.ok(found > 0, "至少应有一个技能");
});

test("所有源文件都不含未替换的占位符或凭据", () => {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js|json|md)$/.test(e.name)) files.push(p);
    }
  };
  walk(ROOT);
  assert.ok(files.length > 20, "应当扫描到全部源文件");
  // 这些模式在本文件里也存在，用拼接构造，避免校验器把自己判为未完成标记
  const placeholders = [new RegExp("<your-" + "[a-z-]+>", "i")];
  const unfinished = new RegExp("TO" + "DO:|FIX" + "ME:");
  const credentials = /(api[_-]?key|secret|password|token)\s*["']?\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}/i;
  for (const f of files) {
    const body = readFileSync(f, "utf8");
    for (const re of placeholders) assert.ok(!re.test(body), `${f} 含未替换占位符`);
    assert.ok(!unfinished.test(body), `${f} 含未完成标记`);
    // 凭据类字段绝不能出现字面量（只能从环境变量读取）
    assert.ok(!credentials.test(body), `${f} 疑似含凭据字面量`);
  }
});

test("不存在 dist 目录（零依赖即无需构建产物）", () => {
  assert.equal(existsSync(join(ROOT, "dist")), false, "若引入构建步骤需同步更新 README 与这里的断言");
});

test("README 两种语言都存在且以实测数字开头", () => {
  for (const name of ["README.md", "README.zh-CN.md"]) {
    const p = join(ROOT, name);
    assert.ok(existsSync(p), `缺少 ${name}`);
    const body = readFileSync(p, "utf8");
    assert.ok(body.length > 1500, `${name} 内容过于单薄`);
    assert.match(body.split("\n").slice(0, 40).join("\n"), /\d/, `${name} 开头应给出具体数字`);
  }
});

test("定价快照结构完整且已剔除全零条目", () => {
  const snap = readJson(join(ROOT, "data", "pricing.snapshot.json"));
  assert.equal(snap.unit, "usd_per_token");
  assert.ok(Object.keys(snap.models).length > 500, "快照应覆盖足够多的模型");
  assert.ok(Array.isArray(snap.rejected) && snap.rejected.length > 0, "应记录被剔除的异常条目");
  for (const [key, m] of Object.entries(snap.models)) {
    assert.ok(m.input > 0 || m.output > 0, `${key} 的价格不应全为 0（全零条目必须已被剔除）`);
    assert.ok(!key.includes("/"), `${key} 不应带命名空间（会导致快照膨胀）`);
  }
});

test("插件体积可控（快照不应失控膨胀）", () => {
  const size = (dir) => {
    let total = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = join(dir, e.name);
      total += e.isDirectory() ? size(p) : statSync(p).size;
    }
    return total;
  };
  const mb = size(ROOT) / 1048576;
  assert.ok(mb < 4, `插件体积 ${mb.toFixed(2)}MB 偏大，快照或测试数据可能失控`);
});
