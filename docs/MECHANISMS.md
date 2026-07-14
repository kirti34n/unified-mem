# How unified-mem works

Eight mechanisms, each observable on the live dashboard. See [CONFIG.md](CONFIG.md) for every knob named here.

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
triggers: when 401s spike under load; when a JWT refresh races   # situation phrases in the user's words
repos: [api-core, auth-service]
files: [src/auth/token.ts, src/middleware/refresh.ts]
source_commit: 8f3ab21
confidence: high
polarity: guidance    # guidance | pitfall (pitfall notes render in a separate "do NOT repeat" block)
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

Repos auto-register: the first real session in any git repo adds it to the config map and writes an instant repo card, so new and old repos are covered the moment you open a session there. The dashboard's Repos view lists every known repo with its note count and last session, and lets you disable memory per repo (no injection, no capture) and re-enable it later.

Abstention is the default, and the mechanism that delivers it is a rarity gate, not a similarity threshold. A query term only counts as evidence if it is substantial (longer than four characters) and discriminative (present in at most 30% of notes), and a note must contain at least two such terms before it may be injected. A prompt with no rare technical vocabulary therefore retrieves nothing, whatever its similarity scores look like.

That distinction is load-bearing rather than pedantic. BM25 similarity is normalized against the best hit in the result set, so the top-ranked note always scores 1.0 no matter how weak its absolute match; a similarity floor consequently cannot reject rank 1, and `start_min_sim` / `prompt_min_sim` only ever trim the tail. The rarity gate is what makes "inject nothing" actually happen. It is enforced by a free, deterministic, LLM-free eval (`node eval/negatives.mjs`) that fires ordinary non-technical prompts from every repo and requires zero retrievals, while separately requiring that real notes stay retrievable, since a gate that abstains on everything would otherwise score perfectly. It currently measures 0 false positives across 280 negative probes with full recall on the positive arm.

Measured results show even irrelevant-but-plausible extra context degrades task performance, so injecting nothing is the correct default. The Metrics view tracks the abstention rate, and technical prompts that match nothing are logged to `index/gaps.jsonl`: the vault's known blind spots, and the only honest evidence base for ever adding embeddings.

```
score = 0.40·similarity + 0.30·q_value + 0.15·recency + 0.15·validity
```

- similarity: SQLite FTS5/BM25 full-text match (no embeddings at this scale)
- q_value: learned usefulness (mechanism 3)
- recency: exponential half-life, default 30 days
- validity: `active 1.0 · needs-review 0.4 · archived 0`

Notes also carry a `triggers:` field (short situation phrases in the user's own words), indexed as a high-weight FTS column so a prompt matches on the SITUATION ("when tests hang on Windows") even when it shares no vocabulary with the note's solution text. After scoring, adaptive-k cuts the ranked list at its largest relative score drop of 50% or more, so a clear cliff drops weak tail matches instead of padding to `k` (proven high-utility notes admitted below the similarity floor are exempt from the cut). Retrieved notes are split by `polarity`: guidance notes inject normally, pitfall notes render in a separate "Known pitfalls, do NOT repeat" block, which the model acts on more reliably than an undifferentiated list.

Injection is capped at roughly 2,500 tokens, written as factual statements, never imperative commands (out-of-band imperatives can trip Claude's prompt-injection defenses). Retrieval is pushed by hooks rather than waiting for the model to think of searching: model-initiated recall is unreliable, and pushed context carries no per-turn tool-definition overhead.

## 2. Reflection: where notes come from

The SessionEnd and PreCompact hooks only enqueue (hooks must return in milliseconds; PreCompact queues mid-session so detail is captured before context is summarized away), and internal headless calls made by the system itself (verification, judging, evaluation) are never captured, so the reflector cannot feed on its own machinery. A background worker reads the transcript and asks a headless Claude to distill it: only durable, reusable knowledge; typed; one claim per note; commit and file provenance mandatory; secrets forbidden by prompt and regex-scanned again before write; near-duplicates suppressed by showing the reflector the ten nearest existing notes; output rejected unless it passes a schema gate. Zero notes is a valid and common outcome.

Two rules research says matter most here: preserve exact details verbatim (error strings, versions, thresholds, flags: dropping specifics during distillation is the top measured failure mode of memory systems), and skip project-local ephemera the built-in per-project memory already owns.

## 3. Q-learning: how usefulness is earned

The worker reads the session's outcome from its transcript: a plainly stated pass ("14 passed", "build succeeded") means `r=1`, a plainly stated failure means `r=0`, and anything ambiguous means no update at all (never guess rewards). Two things are worth being exact about, because this is the mechanism most easily oversold. First, the vault does not invoke a test runner; it reads what the session reports. Second, the bar for "unambiguous" is high on purpose, so on a real vault only about 15% of sessions produce any Q update, which makes Q a slow-moving prior rather than a precise per-note utility. Grounding `r` directly in tool exit status (pairing each `tool_use` with its `tool_result`) is the next planned change. Every injected note gets:

```
Q ← clamp(Q + α·c·(r − Q), 0.05, 0.95)      α=0.3, |ΔQ| ≤ 0.15 per session
```

where `c` comes from a pinned LLM judge with a fixed coarse rubric (1 = the note's fix was directly applied, 0.5 = plausibly helped, 0 = ignored), one cheap call per determinate session, judged against the assistant's own output rather than the whole transcript (matching the transcript would reward notes merely for being injected). The judge writes a one-line rationale per note before its final JSON verdict (rationale-first scoring is measurably more consistent); a note the judge omits or scores unparseably is credited 0 (fail-closed), never silently inflated. The judge model and prompt are pinned deliberately: changing a judge silently makes utility scores incomparable across time. A term-overlap heuristic is the automatic fallback; `contribution_judge: "heuristic"` disables the LLM entirely.

Guardrails: the clamp, the per-session cap, the verifiable-outcome anchor, and a conservative outcome detector (a bare checkmark is not a success signal). Notes that stop contributing decay by `Q·0.95` per idle week, measured from last contribution rather than last injection, so a frequently-retrieved-but-never-helpful note cannot keep itself alive. Below Q 0.20 and unused 60 days, archived. Vault size plateaus instead of growing forever; the trend line is on the Metrics view.

## 4. Staleness: the biggest accuracy lever

Nightly, for every active note: if any file in its `files:` list has commits since the note's `last_validated` (checked with `git log` against your local clones), the note drops to needs-review. A verification pass reads the current code and decides: claims still hold means restored to active with fresh provenance; stale means a strike, and only a second stale verdict on a later run archives (one cheap-model misjudgment must not destroy real knowledge). A 72-hour backoff prevents notes citing hot files from burning the nightly verification budget. Every step appears in the Consolidation view as a diff.

The same nightly job runs a contradiction arbiter on flagged near-duplicate pairs (DUPLICATE / UPDATE / COEXISTING: newest-wins rules both fail to retire outdated facts and wrongly merge compatible ones), auto-links the graph with two zero-cost edge types (co-file and shared-entity, capped at four links per note), and regenerates entity hub pages (`entities/*.md`) and the repo cards (`repos/*.md`) that power cold-start injection.

The arbiter's verdict is executed, not merely logged. On DUPLICATE or UPDATE the losing note is marked `superseded` and gains a `superseded_by:` pointer, and retrieval follows that pointer: when a superseded note wins a slot, the note that replaced it is served in that slot instead. Redirecting rather than merely down-ranking is deliberate, and the reason is worth stating because the intuitive fix does not work. A superseded note is usually the *strongest* match for the very query that surfaces it, since it was written about exactly that symptom, so no reduction in its validity score can unseat it: on this vault the stale note out-scored its own replacement 0.775 to 0.634, while validity's entire weight in the ranking is 0.15. The superseded note is therefore treated as what it actually is, a good retrieval key carrying stale content. The key is kept and the content is swapped. Nothing is deleted, the pointer is a normal frontmatter field, and git holds the history.

## 5. Measurement: prove it helps

See [EVAL.md](EVAL.md) for the full methodology, the honest caveats, and how to build a question set from your own incident history.

## 6. The self-improvement loop

```bash
node scripts/improve.mjs --iterations 5    # or --forever; create a STOP file to halt
```

Research, hypothesis, implement, test, accept or revert, repeat: hill-climbs the retrieval tunables against the A-arm eval score, one knob at a time. Three guards keep it honest: it REFUSES to run against the fictional demo question set (when no `eval/questions.real.json` exists and no `--demo` flag is passed), so it can never tune production config on fiction; it refuses to run below 14 ACTUAL samples per measurement (checked after the run, not just the plan, so a budget-truncated run cannot slip an under-powered decision through); and a noise guard accepts a change only if correctness strictly improves or ties with at least 15% fewer output characters. (At the 14-sample floor a single flipped answer clears the correctness bar, so treat accepted tweaks as suggestions to re-measure, not proofs; grow the question set past the recommended 15 for a firmer signal.) Weights are normalized per scoring call, so no accepted change can break the weighting invariant. Runs as a plain Node process spawning fresh headless calls (no CLI session limits); every iteration logs to `improve/log.jsonl`.

Separately, `node scripts/tune-weights.mjs` is an OFFLINE fitter (no LLM calls). Every injection logs its raw component scores (similarity, q_value, recency, validity); the fitter grid-searches the four retrieval weights to maximize same-session helped-versus-not ranking on that logged history, with a per-component floor so no signal (especially similarity) can be zeroed. It refuses until enough labeled history accumulates, and `--apply` writes the fitted weights into config.

## 7. Backfill: start with your history

`node scripts/backfill.mjs` queues your existing Claude Code session transcripts (from `~/.claude/projects/`) through the normal reflection pipeline, so the vault begins loaded with what you already learned. In this project's own backfill, 8 transcripts across 6 repos produced 27 notes: Windows encoding crashes, model-eviction thrash, CI gotchas, architectural decisions, and a user style preference that then correctly surfaced in every repo.

## 8. The personal layer: preferences and your docs

Preferences are the most cross-repo knowledge there is, so they are a first-class scope, not a bolt-on. Notes carry `scope: shared | personal`; two additional types exist alongside the five knowledge types:

- **preference**: short rules about the user ("prefer pnpm", "conventional commits"). Captured explicitly, three ways: the `vault_remember` MCP tool mid-conversation, `node scripts/remember.mjs "..."` from a shell, or by hand as a markdown file. Validated through the same gates as reflector output (schema, secrets, 150-word cap), provenance-stamped `trust: user-explicit`, starting at Q 0.6 (an explicit statement outranks a distilled guess). At session start, active preferences are **pinned** before the catalog with no similarity floor, budgeted by `personal_budget_chars`. They never decay or auto-archive; retention is manual, bounded by a `preference_cap` warning since every one costs context in every session.
- **reference**: chunks ingested from your own docs via `node scripts/ingest.mjs <file-or-dir>` (`.md`/`.txt`, split by `##` heading, 400-word cap per chunk, secret-bearing chunks skipped). References are deliberately NOT pinned: they flow through the per-prompt rare-term gate like any note, so a style guide chunk appears exactly when a prompt touches its topic. Staleness is tracked by content hash: nightly, a changed source flips its chunks to needs-review (`invalidate-doc`), a missing source archives them, and `consolidate --auto-reingest` re-ingests changed docs automatically. Re-ingesting a file always replaces its previous chunks.

Poisoning boundary: the reflector can never emit `preference` or `reference` (its schema gate is narrowed to the five knowledge types and its output is forced to `scope: shared`), so nothing pinned into every session can originate from a transcript. The init-generated vault `.gitignore` includes a commented `notes/personal/` line for users who share their vault but keep the personal subtree private.

## Cost model

Every pipeline LLM call goes through one budget-guarded path: cost is read from the CLI's own accounting into `index/cost-ledger.jsonl`, the Metrics view shows today's spend against the `daily_budget_usd` cap, and at the cap the pipeline stops calling models until tomorrow (pure-code scoring and consolidation keep running). Reflection always uses the session-grade CLI model (`reflector_model`, sonnet by default): its notes become context for future sessions, so no downgrade routing. Verification, judging, and eval use cheap pinned CLI models; every call goes through the Claude CLI, nothing local. Per determinate session: one reflection call and one small judge call. Per night: up to `verify_cap` verifications plus up to three arbiter calls, all haiku. Internal calls are never re-captured, tiny transcripts are skipped, and one worker drain reflects at most `max_reflections_per_run` sessions.
