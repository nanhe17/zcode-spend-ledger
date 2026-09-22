---
description: 给出可执行的降本建议（每轮固定开销、未用的 MCP、重复读取等）。 / Actionable cost-reduction advice.
argument-hint: "[会话 id | workspace | all]"
---

用户想要降本建议。调用 MCP 工具 `spend_advisor`（它会顺带取上下文成分）。

参数：会话 id 传给 `session_id`；`workspace`/`all` 传给 `scope`；`7d` 之类的值传给 `since`。

呈现规则：
- **按可省金额从大到小**列出，不要按规则顺序罗列。
- 每条都要把**证据**讲出来（服务器名、每轮 token、调用次数、文件路径、覆盖率），
  因为建议的价值全在可核对。用户会问"凭什么这么说"。
- 明确区分两类：**实际测量**（token 数、调用次数、每轮固定开销）与**估算**
  （`savingTokens` 是推算的可省量）。不要把估算说成已省下的钱。
- 对"从未调用过的 MCP 服务器"这类结论，提醒用户关闭它会**影响后续会话能力**，
  是取舍而不是纯收益。
- 若 `findings` 为空，直说本会话没有发现明显浪费，不要为了凑数制造建议。

如果用户是在追问某条建议的依据，进一步调用 `spend_attribution`（工具/文件级）
或 `spend_context_breakdown`（上下文成分）给出明细。
