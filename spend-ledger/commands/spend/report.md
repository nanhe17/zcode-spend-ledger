---
description: ZCode 用量与成本总账（按来源/代理/模式/模型分解）。 / Token and cost report for ZCode.
argument-hint: "[会话 id | 7d | workspace | all]"
---

用户想看用量与成本。优先调用 MCP 工具 `spend_summary`。

参数处理：
- 无参数或会话 id 形如 `sess_...` → `scope: "session"`，有 id 则传 `session_id`。
- 形如 `7d` / `24h` / 日期 → `scope: "session"` 或按语境选 `workspace`，并把值传给 `since`。
- `workspace` / `all` → 对应的 `scope`。

若 `spend_summary` 不可用，明确告诉用户该 MCP 工具未连接，可运行 `/spend:doctor` 排查；
**不要**假设本机存在 `spend-ledger` 命令，也不要编造任何数字。

汇报时遵守这些规则：
- **先给结论**：总费用、请求数、缓存读取占比。
- 复述 `notes` 里的关键提醒，尤其是 `cache-inclusive`（`input_tokens` 已含缓存）与
  `unpriced`（哪些模型没有定价、其 token 未计入费用）。这两条决定了数字该怎么被理解。
- 指出副代理（`query_source=subagent`）与标题生成（`session_title`）各占多少 —— 后者几乎是纯开销。
- 若 `warning` 非空（例如降级为快照只读），一并说明。

不要为了好看而四舍五入掉小额费用；并发请求多时说明这一点。用户若追问"为什么这么贵"，
继续调用 `spend_attribution` 或 `spend_advisor`，而不是凭印象解释。
