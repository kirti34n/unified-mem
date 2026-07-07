# How unified-mem works

Seven mechanisms, each observable on the live dashboard. See [CONFIG.md](CONFIG.md) for every knob named here.

## The layering premise

Claude Code is not amnesiac. It ships with [built-in memory](https://code.claude.com/docs/en/memory): per-project auto-memory that loads each session, the `CLAUDE.md` instructions hierarchy, and `--resume` for session continuity. unified-mem does not replace any of that. It is the layer above:

| Layer | Scope | Holds | Learns? | Staleness? |
|---|---|---|---|---|
| [Session transcripts](https://code.claude.com/docs/en/sessions) (`--resume`) | one conversation | full history | no | no |
| [`CLAUDE.md` hierarchy](https://code.claude.com/docs/en/memory) | user / project | your instructions | no | manual |
| [Auto-memory](https://code.claude.com/docs/en/memory) | one repository | project facts Claude saves | heuristic | none |
| unified-mem | all repositories | durable, verified knowledge | Q-value from real outcomes | git-diff invalidation + re-verification |

Division of labor: project-local ephemera (task state, repo structure, short-lived plans) stays in the built-in layer. Durable, transferable knowledge (verified fixes, technology gotchas, patterns, conventions) is promoted into the unified vault. The reflector prompt enforces this split.

## What a note is

One claim per note, at most 150 words, plain markdown with YAML frontmatter. The whole vault opens in [Obsidian](https://obsidian.md).

```yaml
---
id: 2026-06-16-jwt-refresh-race
type: recovery        # strategy | recovery | optimization | decision | convention
title: JWT refresh race causes 401 bursts under load
entities: [auth-service, jwt, redis]
repos: [api-core, auth-service]
files: [src/auth/token.ts, src/middleware/refresh.ts]
source_commit: 8f3ab21
confidence: high
q_value: 0.50         # learned usefulness: starts neutral, earned over time
status: active        # active | needs-review | archived
links: ["[[2026-06-16-redis-lock-pattern]]"]
---
**Problem:** ...  **Root cause:** ...  **Fix:** ... (commit)  **Gotchas:** ...
```

The `files:` and `source_commit` provenance is not decoration: it is what lets the system detect that the code a note describes has changed.

## 1. Retrieval: which notes get injected

Design principle: cold start gets a map, details load on demand.

- **Session start** injects a compact memory catalog (note counts per repo) plus this repo's card, a nightly-generated overview of what the repo is, its recent git activity, and what the vault knows about it. Only notes that pass the relevance floor for the current git context ride along.
- **Every prompt** (UserPromptSubmit): the prompt itself is the query, injected adjacent to the decision point where models actually use context. Deduplicated against everything already injected this session, behind a frequency-aware precision gate: only query terms appearing in at most 30% of notes count as evidence, and a note must contain at least two such rare terms. Chatty prompts correctly inject nothing.
- **Explicit pull**: the `vault_search` MCP tool.

All paths apply a relevance floor: a note must be meaningfully relevant or have proven high utility, otherwise nothing is injected. Measured results show even irrelevant-but-plausible extra context degrades task performance, so injecting nothing is the correct default. The Metrics view tracks the abstention rate, and technical prompts that match nothing are logged to `index/gaps.jsonl`: the vault's known blind spots, and the only honest evidence base for ever adding embeddings.

```
score = 0.40·similarity + 0.30·q_value + 0.15·recency + 0.15·validity
```

- similarity: SQLite FTS5/BM25 full-text match (no embeddings at this scale)
- q_value: learned usefulness (mechanism 3)
- recency: exponential half-life, default 30 days
- validity: `active 1.0 · needs-review 0.4 · archived 0`

Injection is capped at roughly 2,500 tokens, written as factual statements, never imperative commands (out-of-band imperatives can trip Claude's prompt-injection defenses). Retrieval is pushed by hooks rather than waiting for the model to think of searching: model-initiated recall is unreliable, and pushed context carries no per-turn tool-definition overhead.

## 2. Reflection: where notes come from

The SessionEnd hook only enqueues (hooks must return in milliseconds), and internal headless calls made by the system itself (verification, judging, evaluation) are never captured, so the reflector cannot feed on its own machinery. A background worker reads the transcript and asks a headless Claude to distill it: only durable, reusable knowledge; typed; one claim per note; commit and file provenance mandatory; secrets forbidden by prompt and regex-scanned again before write; near-duplicates suppressed by showing the reflector the ten nearest existing notes; output rejected unless it passes a schema gate. Zero notes is a valid and common outcome.

Two rules research says matter most here: preserve exact details verbatim (error strings, versions, thresholds, flags: dropping specifics during distillation is the top measured failure mode of memory systems), and skip project-local ephemera the built-in per-project memory already owns.

## 3. Q-learning: how usefulness is earned

The worker detects a verifiable outcome per session: tests passed or build green means `r=1`, failures mean `r=0`, anything unclear means no update at all (never guess rewards). Every injected note gets:

```
Q ← clamp(Q + α·c·(r − Q), 0.05, 0.95)      α=0.3, |ΔQ| ≤ 0.15 per session
```

where `c` comes from a pinned LLM judge with a fixed coarse rubric (1 = the note's fix was directly applied, 0.5 = plausibly helped, 0 = ignored), one cheap call per determinate session, judged against the assistant's own output rather than the whole transcript (matching the transcript would reward notes merely for being injected). The judge model and prompt are pinned deliberately: changing a judge silently makes utility scores incomparable across time. A term-overlap heuristic is the automatic fallback; `contribution_judge: "heuristic"` disables the LLM entirely.

Guardrails: the clamp, the per-session cap, the verifiable-outcome anchor, and a conservative outcome detector (a bare checkmark is not a success signal). Notes that stop contributing decay by `Q·0.95` per idle week, measured from last contribution rather than last injection, so a frequently-retrieved-but-never-helpful note cannot keep itself alive. Below Q 0.20 and unused 60 days, archived. Vault size plateaus instead of growing forever; the trend line is on the Metrics view.

## 4. Staleness: the biggest accuracy lever

Nightly, for every active note: if any file in its `files:` list has commits since the note's `last_validated` (checked with `git log` against your local clones), the note drops to needs-review. A verification pass reads the current code and decides: claims still hold means restored to active with fresh provenance; stale means a strike, and only a second stale verdict on a later run archives (one cheap-model misjudgment must not destroy real knowledge). A 72-hour backoff prevents notes citing hot files from burning the nightly verification budget. Every step appears in the Consolidation view as a diff.

The same nightly job runs a contradiction arbiter on flagged near-duplicate pairs (DUPLICATE / UPDATE / COEXISTING: newest-wins rules both fail to retire outdated facts and wrongly merge compatible ones), auto-links the graph with two zero-cost edge types (co-file and shared-entity, capped at four links per note), and regenerates entity hub pages (`entities/*.md`) and the repo cards (`repos/*.md`) that power cold-start injection.

## 5. Measurement: prove it helps

See [EVAL.md](EVAL.md) for the full methodology, the honest caveats, and how to build a question set from your own incident history.

## 6. The self-improvement loop

```bash
node scripts/improve.mjs --iterations 5    # or --forever; create a STOP file to halt
```

Research, hypothesis, implement, test, accept or revert, repeat: hill-climbs the retrieval tunables against the A-arm eval score, one knob at a time. Three guards keep it honest: it defaults to your real question set (the demo set needs an explicit flag), it refuses to run below 14 samples per measurement, and a noise guard accepts a change only if correctness strictly improves or ties with at least 15% fewer output tokens. Weights are normalized at load, so no accepted change can break the weighting invariant. Runs as a plain Node process spawning fresh headless calls (no CLI session limits); every iteration logs to `improve/log.jsonl`.

## 7. Backfill: start with your history

`node scripts/backfill.mjs` queues your existing Claude Code session transcripts (from `~/.claude/projects/`) through the normal reflection pipeline, so the vault begins loaded with what you already learned. In this project's own backfill, 8 transcripts across 6 repos produced 27 notes: Windows encoding crashes, model-eviction thrash, CI gotchas, architectural decisions, and a user style preference that then correctly surfaced in every repo.

## Cost model

Every pipeline LLM call goes through one budget-guarded path: cost is read from the CLI's own accounting into `index/cost-ledger.jsonl`, the Metrics view shows today's spend against the `daily_budget_usd` cap, and at the cap the pipeline stops calling models until tomorrow (pure-code scoring and consolidation keep running). Tier routing sends small transcripts to haiku and reserves the reflector model for large ones. Per determinate session: one reflection call and one small judge call. Per night: up to `verify_cap` verifications plus up to three arbiter calls, all haiku. Internal calls are never re-captured, tiny transcripts are skipped, and one worker drain reflects at most `max_reflections_per_run` sessions.
