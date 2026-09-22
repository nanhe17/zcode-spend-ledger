# spend-ledger（中文说明）

ZCode 用量与成本归因插件。全程只读、离线、零运行时依赖。

英文版见 [README.md](README.md)。

## 实测结果（本机 2026-09 会话数据，非推算）

| 指标 | 数值 |
|---|---|
| 与独立实现（`ccusage zcode`）的 token 对账 | **偏差 0.00%**（新增输入 3,245,995 + 缓存读取 52,012,160 + 输出 768,825） |
| `ccusage` 对同一份数据给出的费用 | **$0**（四个模型全部无定价）；本插件给出真实金额 |
| `input_tokens` 中其实是缓存读取的部分 | **94.0%** —— 按输入原价计价会高估约 **16.7 倍** |
| 每轮固定开销（系统提示 + 工具 schema） | **40,873 token/轮（占输入 22.7%）**，其中工具 schema 38,627 |
| 一个从未被调用过的 MCP 服务器 | `playwright`，25 个工具，**5,261 token/每轮** → 单会话累计 515,617 token |
| 测试 | **77 个测试**，`node --test`，零依赖 |

## 为什么需要它

ZCode 不记录任何成本：`message.cost` 每行都是 `0`，`model_usage` 只存原始 token 数；
而数据里的 provider 有时是不透明 UUID（如 `f1555b88-…`），任何上游定价表都解析不到。
结果是：非 z.ai 供应商的用户在现有工具里一律看到 **$0**，也无法知道钱花在哪。

本插件回答三个当前生态回答不了的问题：

1. **花了多少** —— 本地为每次请求定价，并正确处理缓存语义。
2. **花在哪** —— 把 token 增长归因到具体工具、文件与 MCP 服务器，并给出归因覆盖率。
3. **光是装着这些工具要多少钱** —— 把上下文拆成系统提示、工具 schema（按 MCP 服务器细分）与历史。

## 两条正确性规则，都是踩出来的

**`input_tokens` 已经包含缓存读取与缓存写入。** 实测缓存读取占全部输入的 94.0%，
最坏一行 100% 是缓存读取；若把 `input_tokens` 直接按输入单价计价，会高估约 17 倍。
本插件计算 `新增输入 = input − cache_read − cache_creation`，钳到非负，
并把出现负值当作**上游语义漂移的哨兵**记录下来。

**上游定价表存在「全零占位条目」**（input = 0 且 output = 0）。直接采用会让报告显示 `$0` 却看不出原因。
快照构建期已剔除（当前快照剔除 253 条），运行时再次防御。未知模型一律标记为 `unpriced`
并从合计中排除，**绝不静默按 0 计价**。

## 安装（本地开发市场）

在 ZCode 中：**插件市场 → 添加 → 添加插件市场**，粘贴市场根目录，然后在
**个人 → 该市场 → spend-ledger → 安装**。

依赖 `PATH` 上的 `node`（`>= 22.5`；Node 22/23 需要 `--experimental-sqlite`，Node 24+ 开箱可用）。
`/spend:doctor` 会报告这一项。

## 使用

命令（面向 agent，会替你解读结果）：`/spend:report`、`/spend:advise`、`/spend:composition`、`/spend:doctor`。

终端直接使用：

```bash
node src/entry-cli.mjs report --scope workspace     # 当前工作区
node src/entry-cli.mjs report --since 7d --json     # 近 7 天，机器可读
node src/entry-cli.mjs advise --workspace "D:/my/project"
node src/entry-cli.mjs composition --session sess_xxx
node src/entry-cli.mjs doctor
```

MCP 工具：`spend_summary`、`spend_attribution`、`spend_context_breakdown`、`spend_advisor`。

## 每个数字究竟是什么

来源的可信度比精度更重要，因此明确区分：

- **实测 / 精确**：token 数、请求数、工具调用次数与耗时、每轮固定开销
  （系统提示与工具 schema 在每条请求里都是全量，实测 82 条记录完全一致）、给定定价表下的费用。
- **模型而非测量**：工具与文件级的 token 归因。由「同一轮内相邻请求的上下文增量，扣除助手自身输出后
  按输出体量分摊」推得。因此每次都给出**归因覆盖率**；覆盖率低就说明它只解释了一部分增长。
- **残差**：上下文成分中的历史部分 = 实测输入 − 静态，因此自动包含未记录的消息与未建模字段。
- **校准估算**：成分比例来自按字符密度的加权长度，再缩放使各分项之和等于实测 `input_tokens`。
  密度由 `messagesKind=full` 的记录标定；若没有这类记录，会使用默认密度并发出告警。
- **估算（已标注）**：建议里的 `savingTokens` 是由已发生开销推算的可省量，不是已经省下的钱。

## 数据来源

| 路径 | 用途 |
|---|---|
| `~/.zcode/cli/db/db.sqlite`（只读，WAL） | `model_usage`、`turn_usage`、`tool_usage`、`part`、`session` |
| `~/.zcode/v2/tasks-index.sqlite`（只读） | 会话标题、模式、模型 |
| `~/.zcode/v2/config.json` | provider id → 名称映射（绝不读取凭据） |
| `~/.zcode/cli/rollout/model-io-<会话id>.jsonl` | 成分分析所需的完整请求体 |

只读打开，三级降级：`readOnly` 直连 → 复制 `db` + `-wal` + `-shm` 到临时目录 → `immutable=1`。
`/spend:doctor` 会报告实际用了哪一级。绝不写入 ZCode 的任何数据库，也绝不读取 `v2/credentials.json`。

## 隐私

全部本地完成，正常运行不联网（只有显式运行的 `scripts/build-pricing-snapshot.mjs` 会拉取定价）。
成分分析默认不输出提示原文，只给类别名与 token 数。

## 定价

`data/pricing.snapshot.json` 内含从 LiteLLM 与 models.dev 构建的 1,870 个规范模型。
解析顺序：用户覆盖 → 内置快照 → 未定价。要补一个上游不认识的模型（不透明 provider UUID 很常见），
把 `data/pricing.override.example.json` 复制为 `${ZCODE_PLUGIN_DATA}/pricing.override.json` 即可。

更新快照：`npm run pricing:update`。

## 自己验证

```bash
npm test          # 77 个测试：定价陷阱、归因数学、真实 schema 夹具、MCP 协议
npm run reconcile # 与 ccusage 的 ZCode 适配器逐 token 对账
npm run doctor
```

`npm run reconcile` 最值得一看：它在同一个库上跑一个独立实现并对比 token，目前三类 token 偏差均为 0.00%。
费用**预期**不同，脚本会说明原因。

## 目录结构

```
src/            paths db pricing attribution composition advisor ledger render view i18n
                entry-cli.mjs（命令行）  entry-mcp.mjs（MCP 服务）
commands/spend/ report advise composition doctor
skills/         spend-analysis
data/           pricing.snapshot.json, pricing.override.example.json
scripts/        build-pricing-snapshot  reconcile-ccusage  p0-probe  p0b-part-shape
test/           pricing attribution composition advisor report mcp
test-support/   fixture.mjs（真实 schema 的 SQLite 夹具）
```

没有构建步骤，也没有 `dist/`：零运行时依赖，直接运行的就是 ESM 源码，审到的是什么就跑什么。

## 许可

MIT
