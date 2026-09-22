---
description: 自检数据源、定价覆盖、账本与运行时。 / Diagnose the data source, pricing coverage and runtime.
argument-hint: ""
---

用户遇到了"数字不对"或"工具没反应"。运行自检以定位问题。

优先在终端执行（若 `ZCODE_PLUGIN_ROOT` 可用）：

```bash
node "${ZCODE_PLUGIN_ROOT}/src/entry-cli.mjs" doctor
```

若该变量不可用，在插件缓存目录里定位并执行：

```bash
ls -d ~/.zcode/cli/plugins/cache/*/spend-ledger/*/src/entry-cli.mjs 2>/dev/null | head -1
```

**不要**假设本机有全局 `spend-ledger` 命令，也不要安装任何东西。

逐项解读（这些是常见真实故障）：
- `usage-db` 为 fail → 找不到用量库，检查 `ZCODE_HOME` 与 `~/.zcode/cli/db/db.sqlite` 是否存在。
- `open-mode` 为 warn → 只读直连失败，已降级为快照复制（数据仍可读，但可能与活库有一瞬差异）；
  若显示 `immutable`，数据可能偏旧，需查明原因。
- `json1` 为 fail → 该 SQLite 缺 JSON1，文件级归因不可用。
- `unpriced-models` 为 warn → 列出实际用过但无定价的模型，这些模型的 token **未被计入费用**。
  这是最影响"金额看起来不对"的一项；用户可按 README 的覆盖模板补价。
- `pricing-snapshot` 为 warn → 快照过期（>90 天），可重新运行 `scripts/build-pricing-snapshot.mjs` 更新。
- `model-io` 为 warn 且 `全量保留=false` → 上下文成分分析只能读到当前活跃会话，历史会话可能已被清理。

报告结论时区分「数据源问题」与「定价覆盖问题」——前者会让所有数字都不可信，
后者只影响金额、不影响 token。最后给出具体的下一步，而不是笼统地说"建议检查配置"。
