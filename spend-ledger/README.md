# spend-ledger

Token and cost attribution for ZCode. Read-only, offline, zero runtime dependencies.

## Measured results (this machine, 2026-09 session data — not projections)

| What | Number |
|---|---|
| Token reconciliation vs an independent implementation (`ccusage zcode`) | **0.00% delta** on 3,245,995 fresh + 52,012,160 cache-read + 768,825 output tokens |
| Cost that `ccusage` reports for the same data | **$0** (all four models unpriced) → spend-ledger reports the real number |
| Share of `input_tokens` that is actually cache reads | **94.0%** — pricing `input_tokens` at the face rate overstates cost by **16.7×** |
| Fixed per-request overhead (system prompt + tool schemas) | **40,873 tokens/request (22.7% of input)**, of which tool schemas are **38,627** |
| One MCP server that was never called, ever | `playwright`, 25 tools, **5,261 tokens/request** → 515,617 tokens in one session |
| Test suite | **77 tests**, `node --test`, zero dependencies |

## Why this exists

ZCode records no cost anywhere. `message.cost` is `0` in every row; `model_usage` stores raw token
counts only. Providers in the data are sometimes opaque UUIDs (`f1555b88-…`) that no upstream pricing
table resolves. The result is that on non-z.ai providers, existing tools report **$0** and you cannot
tell which part of a session paid for it.

spend-ledger answers three questions the current ecosystem does not:

1. **What did this cost?** — prices every request locally, with cache-aware token math.
2. **What spent it?** — attributes token growth to specific tools, files and MCP servers, and reports
   how much of the growth the model actually explains (coverage).
3. **What is the fixed cost of just having these tools installed?** — breaks context into system
   prompt, tool schemas (per MCP server), and history.

## Two correctness rules, both learned the hard way

**`input_tokens` already includes cache read and cache write.** Measured: cache reads are 94.0% of all
input, and the worst single row was 100% cached. Pricing `input_tokens` at the input rate overstates
cost by ~17×. spend-ledger computes `fresh = input − cache_read − cache_creation`, clamps at zero, and
counts any negative result as a health signal (it would mean the upstream semantics drifted).

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
| `/spend:composition` | Context breakdown: system prompt, tool schemas, MCP servers, history |
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
- **A residual**: the history portion of the context breakdown is `observed input − static`, so it
  absorbs unlogged messages and unmodeled request fields.
- **Calibrated estimates**: composition proportions come from length-based weights, scaled so the parts
  sum to the measured `input_tokens`. Density is calibrated on `messagesKind=full` records; if none
  exist, a default density is used and a warning is emitted.
- **Estimates, labeled as such**: `savingTokens` in advice output is a projection from observed spend,
  not money already saved.

## Data sources

| Path | Used for |
|---|---|
| `~/.zcode/cli/db/db.sqlite` (read-only, WAL) | `model_usage`, `turn_usage`, `tool_usage`, `part`, `session` |
| `~/.zcode/v2/tasks-index.sqlite` (read-only) | session titles, mode, model |
| `~/.zcode/v2/config.json` | provider id → name mapping (credentials never read) |
| `~/.zcode/cli/rollout/model-io-<sessionId>.jsonl` | full request bodies for composition analysis |

Opened read-only, with a three-step fallback: direct `readOnly` → copy `db` + `-wal` + `-shm` to a temp
directory → `immutable=1`. `/spend:doctor` reports which mode was used. Nothing in ZCode's database is
ever written. `v2/credentials.json` is never read.

## Privacy

Everything is local. No network access during normal operation (only `scripts/build-pricing-snapshot.mjs`,
run deliberately, fetches pricing). Composition analysis does not print prompt text by default —
it emits category names and token counts only.

## Pricing

A pinned snapshot of 1,870 canonical models built from LiteLLM and models.dev ships in
`data/pricing.snapshot.json`. Resolution order: user override → pinned snapshot → `unpriced`.
To add pricing for a model upstream does not know (common with opaque provider UUIDs), copy
`data/pricing.override.example.json` to `${ZCODE_PLUGIN_DATA}/pricing.override.json`.

Refresh the snapshot with `npm run pricing:update`.

## Verifying it yourself

```bash
npm test                    # 77 tests: pricing traps, attribution math, real-schema fixture, MCP protocol
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
scripts/        build-pricing-snapshot  reconcile-ccusage  p0-probe  p0b-part-shape
test/           pricing attribution composition advisor report mcp
test-support/   fixture.mjs (real-schema SQLite fixture)
```

There is no build step and no `dist/`: with zero runtime dependencies the ESM sources are what runs, so
what you audit is what executes.

## License

MIT
