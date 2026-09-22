---
name: spend-analysis
description: Use when the user asks what a ZCode session or project cost, why it was expensive, which tools/files/MCP servers consumed the tokens, how much of the context is fixed overhead, or how to reduce token spend. Also use when interpreting numbers from the spend-ledger plugin's commands or MCP tools, or when the user asks whether a token/cost figure is trustworthy.
---

# 用量与成本分析

回答"花了多少、花在哪、怎么省"时使用。数据全部来自本地只读文件，不联网、不上报。

## 数据来源（决定结论可信度的边界）

| 来源 | 内容 | 可信度 |
|---|---|---|
| `~/.zcode/cli/db/db.sqlite` | `model_usage` 每次请求的 token 与维度、`turn_usage` 每轮汇总、`tool_usage` 每次工具耗时与输出体量、`part` 工具结果与文件路径 | 精确 |
| `~/.zcode/cli/rollout/model-io-<sessionId>.jsonl` | 完整请求体（system 块、tools schema、messages）与实测 usage | 精确，但 `messages` 是窗口 |

两个必须知道的语义（否则数字会被系统性误读）：

1. **`input_tokens` 已包含缓存读取与写入。** 新增输入 = `input − cache_read − cache_creation`。
   实测本地 542 条请求中缓存读取占输入 93.4%，若按输入原价直接计价会高估约 15 倍。
2. **库里没有任何成本列**（`message.cost` 恒为 0），金额一律由本地定价表算出。
   未定价的模型必须显式说明"其 token 未计入费用"，不能当成 $0。

## 何时用哪个工具

- 总账与维度分解 → `spend_summary`
- 归因到工具/文件、看覆盖率 → `spend_attribution`
- 上下文固定开销与 MCP 拆分 → `spend_context_breakdown`
- 可执行建议 → `spend_advisor`
- 数字可疑 → 让用户运行 `/spend:doctor`

## 三件必须讲清的事

**归因是模型不是测量。** 工具/文件级 token 由「同一轮内相邻请求的增量，扣除助手自身输出后按输出体量分摊」推得。
因此始终同时给出 `coverage`（已归因 / 总增量）。覆盖率低就说明模型没解释掉大部分增长，
此时不要逐条列举工具开销并暗示其精确。

**成分分析里静态与历史性质不同。** 系统提示与工具 schema 在每条请求里都是全量，逐条精确；
历史是残差。token 密度由 `messagesKind=full` 的记录标定；若 `calibration.source` 是 `default`，
绝对值不可信，必须告知。

**可省估算是估算。** `savingTokens` 是推算，不是已省下的钱。区分「实测」（token 数、调用次数、
每轮固定开销）与「估算」（可省量）。

## 高价值结论的样子

- 每轮固定开销 × 请求数：一个从未被调用的 MCP 服务器在整个会话里烧掉多少 token。
- 副代理与标题生成（`session_title`）各占总量的比例。
- 上下文膨胀：后半段每轮输入是前半段的几倍，以及超出部分折合多少。
- 重复读取同一文件的可省量。

## 边界

不修改任何数据；不读取 `~/.zcode/v2/credentials.json`；默认不输出提示原文。
用户问"要不要关掉某个 MCP"时，说明这是能力与成本的取舍，把每轮固定开销和调用次数都给出来让他自己决定。
