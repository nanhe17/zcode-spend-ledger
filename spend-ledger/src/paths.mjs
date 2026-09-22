// 路径解析：定位 ZCode 的数据文件与插件的自有数据目录。
//
// 硬性约束：
//   1. 绝不写入 ZCode 自己的数据库或任何被读取的文件——本插件全程只读。
//   2. 绝不写入插件安装目录（${ZCODE_PLUGIN_ROOT}）：该目录按版本号分区，升级即丢失。
//   3. 绝不读取 v2/credentials.json。
import { existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const PLUGIN_ID = "spend-ledger";

export function resolveHome(env = process.env) {
  return env.ZCODE_HOME || join(homedir(), ".zcode");
}

export function zcodePaths(env = process.env) {
  const home = resolveHome(env);
  return {
    home,
    db: join(home, "cli", "db", "db.sqlite"),
    tasksIndex: join(home, "v2", "tasks-index.sqlite"),
    rolloutDir: join(home, "cli", "rollout"),
    providerConfig: join(home, "v2", "config.json"),
    settings: join(home, "v2", "setting.json"),
  };
}

// 插件自有数据目录。宿主机通常注入 ZCODE_PLUGIN_DATA；
// 缺失时退回临时目录（照 android-emulator 的防御式写法），保证永不写到安装目录。
export function dataDir(env = process.env) {
  const base = env.ZCODE_PLUGIN_DATA || join(tmpdir(), `${PLUGIN_ID}-plugin`);
  const dir = join(base);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    const fallback = join(tmpdir(), `${PLUGIN_ID}-plugin`);
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
  return dir;
}

export function dataFile(name, env = process.env) {
  return join(dataDir(env), name);
}

export function pluginRoot(env = process.env) {
  return env.ZCODE_PLUGIN_ROOT || env.CLAUDE_PLUGIN_ROOT || process.cwd();
}

// 快照随插件发布，位于插件根目录的 data/ 下。
// 允许用 SPEND_LEDGER_SNAPSHOT 覆盖，便于测试与自备定价表。
export function snapshotPath(env = process.env) {
  return env.SPEND_LEDGER_SNAPSHOT || join(pluginRoot(env), "data", "pricing.snapshot.json");
}

// 用户覆盖定价：优先环境变量，其次插件数据目录。
// 由于 provider_id 在数据里可能是不透明 UUID，覆盖文件是补齐定价的主要手段。
export function overridePath(env = process.env) {
  return env.SPEND_LEDGER_OVERRIDES || dataFile("pricing.override.json", env);
}

export function describeSources(env = process.env) {
  const p = zcodePaths(env);
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { path: v, exists: existsSync(v) }]));
}
