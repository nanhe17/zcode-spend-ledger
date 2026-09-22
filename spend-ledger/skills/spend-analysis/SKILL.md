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
| `~/.zcode/cli/rollout/model-io-<sessionId>.jsonl` | 请求体（system 块、tools schema、messages） | 精确，但**是滚动窗口**：按体积截断，只保留最近的请求；其记录数不等于会话请求总数 |

两条必须知道的语义（否则数字会被系统性误读）：

1. **`input_tokens` 已包含缓存读取与写入。** 新增输入 = `input − cache_read − cache_creation`。
   实测本地请求中缓存读取占输入 96.1%，若按输入原价直接计价会高估约 25 倍。
2. **库里没有任何成本列**（`message.cost` 恒为 0），金额一律由本地定价表算出。
   未定价的模型必须显式说明"其 token 未计入费用"，不能当成 $0。

## 何时用哪个工具

- 总账与维度分解 → `spend_summary`
- 归因到工具/文件、看覆盖率 → `spend_attribution`
- 静态上下文构成与按 MCP 服务器细分 → `spend_context_breakdown`
- 可执行建议 → `spend_advisor`
- 数字可疑 → 让用户运行 `/spend:doctor`

## 上下文成分：不要和宿主面板竞争

**绝对上下文成分由 ZCode 内置的「上下文容量」面板负责，那是权威来源**（用客户端自身记账，
分母就是本次请求的 `input_tokens`，实测与库内数值精确吻合）。本插件**刻意不估算绝对 token 数**，
原因有实测依据：用单一全局密度估算静态部分得到 40,873 token，面板给 75,425，差 1.85 倍
（JSON 工具 schema 的 token 密度远高于散文）；改做最小二乘反解又因 `full` 记录只在会话开头、
外推病态而失败。所以 `spend_context_breakdown` 只输出**精确字符量**与**密度无关的占比**
（占比在同一类内容内部计算，密度会约掉），并只补面板没有的一层：**这些 MCP 工具定义分别来自哪个服务器**。

被问到"上下文里装了什么"时，先请用户看面板；被问到"是哪个 MCP 服务器占的"时才用本插件。

## 三件必须讲清的事

**归因是模型不是测量。** 工具/文件级 token 由「同一轮内相邻请求的增量，扣除助手自身输出后按输出体量分摊」推得。
因此始终同时给出 `coverage`（已归因 / 总增量）。覆盖率低就说明模型没解释掉大部分增长，
此时不要逐条列举工具开销并暗示其精确。

**可省估算必须带上折算口径。** 每条建议都有 `savingKind`：
- `tokens-fresh` —— 新进上下文的内容，按实测新增输入单价
- `tokens-cached` —— 被反复重发的上下文，按实测缓存读取单价（实测比新增输入便宜约 41 倍）
- `chars-static` —— 常驻缓存的静态内容，**只报字符与占比，不给金额**（折算美元会高估约 41 倍）
- `none` —— 信息性，无可省估算

报价时必须沿用该口径。把 `chars-static` 的字符量说成"能省多少钱"是明确错误。

**上下文膨胀的判据。** 用单次请求的 `input_tokens`（上下文规模）比较前后半段，
**不要**用一轮内所有请求的输入之和——后者会把"轮内请求数"误读成上下文增长。

## 高价值结论的样子

- 成本三桶（输出 / 缓存读取 / 新增输入）谁占大头 —— 这决定该改什么。
- 副代理与标题生成（`session_title`）各占总量的比例。
- 重复读取同一文件的可省量（属新增输入口径，是真金白银）。
- 哪些 MCP 服务器占工具定义最多、其中哪些在窗口内从未被调用（属常驻字符口径）。

## 边界

不修改任何数据；不读取 `~/.zcode/v2/credentials.json`；不输出提示原文或工具描述内容。
用户问"要不要关掉某个 MCP"时，说明这是能力与成本的取舍：把字符占比与调用次数都给出来，
并说明该内容常驻缓存、金额影响很小，真实收益是上下文窗口与长会话余量，让他自己决定。
