# zcode-spend-ledger

A [ZCode](https://zcode.z.ai) plugin marketplace. Currently contains one plugin.

## Install

In ZCode, open **Plugin Marketplace → Add → Add Plugin Marketplace**, paste:

```
nanhe17/zcode-spend-ledger
```

Then install **spend-ledger** from **Personal → this market**. Or from the input box:

```
/plugin marketplace add nanhe17/zcode-spend-ledger
/plugin install spend-ledger@zcode-spend-ledger
```

## Plugins

### [spend-ledger](./spend-ledger) — token and cost attribution

ZCode records no cost anywhere: `message.cost` is `0` in every row and `model_usage` stores raw token
counts only. Providers are sometimes opaque UUIDs that no upstream pricing table resolves, so on
non-z.ai providers existing tools report **$0** and you cannot tell what spent the tokens.

spend-ledger prices every request locally and attributes the spend:

- **What did this cost?** — cache-aware pricing; `input_tokens` already includes cache read and write,
  so pricing it at face value overstates cost by ~17× on real data.
- **What spent it?** — attributes token growth to tools, files and MCP servers, and reports how much of
  the growth the model actually explains (coverage).
- **What is worth its cost?** — splits spend by request source (main turn / subagent / title
  generation), agent, mode and model, and shows which MCP servers are consuming tool-definition space.
  It deliberately does **not** re-implement context composition: ZCode's built-in Context capacity panel
  does that better, so this plugin only adds what the panel lacks — the per-MCP-server split.

Measured on real data, not projected: token totals reconcile **0.00%** against an independent
implementation (`ccusage zcode`), and 96.1% of `input_tokens` turns out to be cache reads — so pricing
at the face rate would overstate cost ~25×. The same data shows cache-resident content costs ~41× less
per token than fresh input, which is why every savings estimate here declares which rate it used.

Read-only, offline, zero runtime dependencies. See [spend-ledger/README.md](./spend-ledger/README.md)
for the full method, its limits, and how to verify the numbers yourself.

**Requires** `node >= 22.5` on `PATH` (Node 22/23 need `--experimental-sqlite`; Node 24+ works as-is).

## Repository layout

```
marketplace.json          the marketplace catalog
spend-ledger/             the plugin
  .zcode-plugin/plugin.json
  .mcp.json
  commands/spend/         /spend:report, /spend:advise, /spend:composition, /spend:doctor
  skills/spend-analysis/
  src/                    implementation (no build step — the sources are what runs)
  data/                   pinned pricing snapshot
  test/                   95 tests
  scripts/                pricing snapshot builder, reconciliation against ccusage
```

## License

MIT — see [LICENSE](./LICENSE).
