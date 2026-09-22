---
description: 拆解上下文成分：系统提示 / 工具 schema / 各 MCP 服务器 / 历史。 / Break down what fills the context.
argument-hint: "[会话 id]"
---

用户想知道上下文里到底装了什么。调用 MCP 工具 `spend_context_breakdown`（`session_id` 可选）。

汇报时**必须**同时说明方法与限制，否则这些数字会被误读成精确测量：
- 静态部分（系统提示 + 工具 schema）在每条请求里都是全量，因此**逐条精确可算**，是本工具最可靠的输出。
- 历史部分按「实测输入 − 静态」的**残差**得出，因此自动包含未被日志记录的消息与未建模字段
  （如 `tool_choice`、thinking）。它不是一个独立测量。
- token 密度由 `messagesKind=full` 的记录标定（返回里的 `calibration`）。
  若 `calibration.source` 是 `default`，说明没有完整记录可标定，绝对值误差可能较大，**必须**主动告知用户。
- `request.messages` 在长会话里是窗口（`delta`/`tail`），所以不要拿它的条数当会话长度。

最有价值的结论通常是「每轮固定成本」：`staticPerRequest` 与按 MCP 服务器拆出的 `mcpPerRequest`。
把它与请求数相乘，就能说明一个不用的 MCP 服务器在整个会话里烧掉多少。

不要输出提示原文（默认不返回）；用户若明确要求看片段，需重新调用并显式开启该选项，
并提醒这会读到完整提示内容。
