// MCP 服务入口。任何启动期异常都写 stderr 并以非零码退出——
// stdout 必须保持干净，否则会污染 JSON-RPC 流。
import { serve } from "./mcp-server.mjs";

try {
  serve({ env: process.env });
} catch (err) {
  process.stderr.write(`spend-ledger mcp server failed: ${err?.stack ?? err}\n`);
  process.exit(1);
}
