# spend-ledger

Token and cost attribution for ZCode. Read-only, offline, zero runtime dependencies.

## Measured results (this machine, 2026-09 session data — not projections)

| What | Number |
|---|---|
| Token reconciliation vs an independent implementation (`ccusage zcode`) | **0.00% delta** on 3,245,995 fresh + 52,012,160 cache-read + 768,825 output tokens |
| Cost that `ccusage` reports for the same data | **$0** (all four models unpriced) → spend-ledger reports the real number |
| Share of `input_tokens` that is actually cache reads | **96.1%** — pricing `input_tokens` at the face rate overstates cost by **~25×** |
| Cost split (workspace, $1.81 total) | output **38.7%** · cache read **30.8%** · fresh input **30.5%** |
| What the fixed tooling actually costs | MCP tool definitions are **59,924 of 133,492 characters** of tool schemas (44.9%); `playwright` alone is 18,281 characters across 25 tools and was never called in the analysed window |
| A savings estimate that used the wrong rate | cache-resident content priced at the fresh-input rate overstates savings by **41×** in real data (measured USD 3.00e-7 vs 6.00e-9 per token — a 50× spread) |
| Test suite | **98 tests**, `node --test`, zero dependencies |

## Why this exists

ZCode records no cost anywhere. `message.cost` is `0` in every row; `model_usage` stores raw token
counts only. Providers in the data are sometimes opaque UUIDs (`f1555b88-…`) that no upstream pricing
table resolves. The result is that on non-z.ai providers, existing tools report **$0** and you cannot
tell which part of a session paid for it.

spend-ledger answers three questions the current ecosystem does not:

1. **What did this cost?** — prices every request locally, with cache-aware token math.
2. **What spent it?** — attributes token growth to specific tools, files and MCP servers, and reports
   how much of the growth the model actually explains (coverage).
3. **Which parts of this workflow are worth their cost?** — splits spend by request source (main turn /
   subagent / title generation), agent, mode and model.

It does **not** try to do context composition. ZCode already has a **Context capacity** panel that
breaks the current context into messages / system tools / MCP tools / skills / system prompt using the
client's own accounting — that is authoritative, and this plugin deliberately does not compete with it.
What that panel cannot tell you is *which* of your MCP servers the "MCP tools" bucket consists of, so
this plugin provides exactly that split, plus the exact character counts behind it.

## Three correctness rules, all learned the hard way

**`input_tokens` already includes cache read and cache write.** Measured: cache reads are 96.1% of all
input, and the worst single row was 100% cached. Pricing `input_tokens` at the input rate overstates
cost by ~25×. spend-ledger computes `fresh = input − cache_read − cache_creation`, clamps at zero, and
counts any negative result as a health signal (it would mean the upstream semantics drifted).

**Content that stays resident in the cache is ~41× cheaper per token than fresh input** (measured
3.00e-7 vs 6.00e-9 USD/token on real data). Any savings estimate that prices cache-resident content at
the fresh-input rate is off by that factor. Every finding this plugin emits therefore declares its
basis — `tokens-fresh`, `tokens-cached`, `chars-static` (characters and share only, no dollar figure)
or `none` — and the rates come from your own observed spend, not a price list.

**Absolute context composition is not estimated, on purpose.** Two attempts were measured and
rejected: a single global token density put the static part at 40,873 tokens where the built-in panel
says 75,425 (off by 1.85×, because JSON tool schemas tokenize far denser than prose), and a
least-squares fit of `input_tokens` against message length is ill-conditioned because `full` records
only occur at session start (it produced a physically impossible 4.88 tokens per weighted character).
See `scripts/fit-static-probe.mjs`. The plugin reports exact character counts and density-free shares
instead; read the panel for absolute tokens.

**Upstream pricing tables contain all-zero placeholder rows** (input = 0, output = 0). Using them makes
a report show `$0` with no visible reason. The snapshot builder rejects them (253 rejected in the
current snapshot) and the pricer re-checks at runtime. Unknown models are reported as `unpriced` and
excluded from totals — never silently priced at zero.

## Install (local development marketplace)

```bash
# from a workspace containing plugins/spend-ledger and plugins/marketplace.json
```

Then in ZCode: **Plugin Marketplace → Add → Add Plugin Marketplace**, paste the marketplace root
directory, then **Personal → the market → spend-ledger → Install**.

Requires `node` on `PATH` (`>= 22.5`; Node 22/23 need `--experimental-sqlite`, Node 24+ works as-is).
`/spend:doctor` reports this.

## Usage

Commands (agent-facing, interpret results for you):

| Command | What it does |
|---|---|
| `/spend:report` | Totals and breakdowns by source / agent / mode / model |
| `/spend:advise` | Actionable findings with evidence and estimated savings |
| `/spend:composition` | Static context: exact character counts and per-MCP-server shares |
| `/spend:doctor` | Data source, pricing coverage, ledger, runtime |

Direct terminal use:

```bash
node src/entry-cli.mjs report --scope workspace            # current workspace
node src/entry-cli.mjs report --since 7d --json            # last 7 days, machine-readable
node src/entry-cli.mjs advise --workspace "D:/my/project"
node src/entry-cli.mjs composition --session sess_xxx
node src/entry-cli.mjs doctor
```

MCP tools (for the agent): `spend_summary`, `spend_attribution`, `spend_context_breakdown`,
`spend_advisor`.

## What each number really is

Honesty about provenance matters more than precision here, so:

- **Measured / exact**: token counts, request counts, tool call counts and durations, per-request fixed
  overhead (system prompt and tool schemas are sent in full on every request — verified constant across
  82 records), cost given a price table.
- **A model, not a measurement**: tool- and file-level token attribution. It is computed from the
  context increment between consecutive requests in a turn, minus the assistant's own output, then
  distributed by output bytes. Every response therefore carries a **coverage** figure
  (`attributed / total growth`); if coverage is low, the breakdown explains only part of the growth.
- **Exact, no estimation**: character counts of the system prompt and tool schemas, and each MCP
  server's share of the tool-schema characters. Shares are computed *within* one content class, where
  the token density cancels out, so they need no tokenizer and no density assumption.
- **Estimates with a declared basis**: `savingTokens` in advice output is a projection from observed
  spend, and each finding says which rate applies (`tokens-fresh` / `tokens-cached` / `chars-static` /
  `none`). `chars-static` findings deliberately carry **no** dollar figure.
- **Not attempted at all**: absolute context composition in tokens. Read the built-in Context capacity
  panel; see the correctness rules above for the two rejected attempts.

## Data sources

| Path | Used for |
|---|---|
| `~/.zcode/cli/db/db.sqlite` (read-only, WAL) | `model_usage`, `turn_usage`, `tool_usage`, `part`, `session` |
| `~/.zcode/v2/tasks-index.sqlite` (read-only) | session titles, mode, model |
| `~/.zcode/v2/config.json` | provider id → name mapping (credentials never read) |
| `~/.zcode/cli/rollout/model-io-<sessionId>.jsonl` | request bodies for the static context measurement. **This file is a rolling window**, truncated by size: it retains only the most recent requests, so its record count is not the session's request count, and results depend on when you run it. Static context is constant within a session, so the measurement itself is unaffected. |

Opened read-only, with a three-step fallback: direct `readOnly` → copy `db` + `-wal` + `-shm` to a temp
directory → `immutable=1`. `/spend:doctor` reports which mode was used. Nothing in ZCode's database is
ever written. `v2/credentials.json` is never read.

## Privacy

Everything is local. No network access during normal operation (only `scripts/build-pricing-snapshot.mjs`,
run deliberately, fetches pricing). The static context measurement outputs category names, character
counts and server names only — never prompt text or tool descriptions.

## Pricing

A pinned snapshot of 1,865 canonical models built from LiteLLM and models.dev ships in
`data/pricing.snapshot.json`. Resolution order: user override → pinned snapshot → `unpriced`.
To add pricing for a model upstream does not know (common with opaque provider UUIDs), copy
`data/pricing.override.example.json` to `${ZCODE_PLUGIN_DATA}/pricing.override.json`.

Refresh the snapshot with `npm run pricing:update`.

## Verifying it yourself

```bash
npm test                    # 99 tests: pricing traps, savings-rate basis, attribution math, real-schema fixture, MCP protocol
npm run reconcile           # token-by-token comparison against ccusage's ZCode adapter
npm run doctor
```

`npm run reconcile` is the interesting one: it runs an independent implementation over the same
database and diffs the tokens. It currently reports 0.00% on all three token categories. Cost is
expected to differ, and the script says why.

## Repository layout

```
src/            paths db pricing attribution composition advisor ledger render view i18n
                entry-cli.mjs (commands)  entry-mcp.mjs (MCP server)
commands/spend/ report advise composition doctor
skills/         spend-analysis
data/           pricing.snapshot.json, pricing.override.example.json
scripts/        build-pricing-snapshot  reconcile-ccusage  fit-static-probe  p0-probe  p0b-part-shape
test/           pricing attribution composition advisor report mcp mcp-stdio plugin-manifest
test-support/   fixture.mjs (real-schema SQLite fixture)
```

There is no build step and no `dist/`: with zero runtime dependencies the ESM sources are what runs, so
what you audit is what executes.

## License

MIT
