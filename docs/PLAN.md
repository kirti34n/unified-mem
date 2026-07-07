# Cross-Repo Evolving Memory System for Claude Code
### Implementation Plan + Live Visualization Layer
*Version 1.1 — 2026-07-07 — this repo (`unified_mem`) IS the knowledge vault*

---

## 1. Executive Summary

**Goal:** Give every Claude Code session across all repositories access to accumulated institutional knowledge — how problems were fixed, what patterns work, what to avoid — in a system that *improves its own accuracy over time* instead of rotting. **And make every mechanism of that system visible on a live local dashboard**, so "is the memory actually working?" is answered by looking, not guessing.

**The one-sentence architecture:** A git-versioned markdown knowledge vault of atomic, linked notes (Obsidian-compatible), written by a reflection pass after each session, injected at session start by relevance × usefulness score, maintained by a nightly consolidation job (merge / decay / invalidate), and **observed end-to-end through a zero-dependency live dashboard on `localhost:7777`**.

**Key research numbers shaping the design:**
- Evolving-playbook contexts (ACE) gained **+10.6%** on agent benchmarks from natural execution feedback alone.
- Un-consolidated memory degrades fast: **~30% redundant entries by session 10, contradictions by ~50**.
- Algorithmic forgetting achieved **~90% noise reduction** while keeping recall.
- Utility-scored retrieval (rank by "did this memory actually help before?") fixes RAG's core failure: semantically similar but strategically useless results.

---

## 2. Problem Statement — corrected premise

Claude Code sessions are NOT amnesiac. Built-ins already cover the per-session and
per-project layer: **auto-memory** (per-project memory directory, loaded each session),
**CLAUDE.md** (instructions hierarchy), **`--resume`/`--continue`** (session transcripts).
unified-mem is NOT a replacement for those — it is the **unified layer on top of them**,
covering exactly what they don't:

1. **Cross-repo blindness** — built-in memory is keyed by working directory. A fix discovered in `repo-A` never reaches `repo-B`; every project's memory is an island. The unified layer shares durable knowledge across all repos.
2. **No learning loop** — nothing built-in measures whether a remembered fact actually *helps*; nothing scores usefulness from session outcomes. Here, notes earn Q-value from verifiable outcomes and decay when they stop contributing.
3. **No staleness handling** — no built-in mechanism notices that the code a memory describes has changed. Stale memory is *worse than no memory*; the unified layer git-diff-invalidates and re-verifies notes against the code they cite.
4. **No observability** — even a working memory loop is invisible: you can't see what was injected, whether it helped, what got merged or invalidated. The dashboard makes the loop inspectable.

**Division of labor:** project-local, ephemeral context (current task state, repo structure, short-lived plans) stays in the built-in per-project memory; durable, transferable knowledge (verified fixes, technology gotchas, patterns, conventions) is promoted into the unified vault. The reflector prompt enforces this split so the two layers complement instead of duplicating each other — session memory keeps the session coherent, the unified layer makes the whole code-generation flow accurate across every repo.

---

## 3. Research Foundation → Design Rules

| # | Finding | Design rule |
|---|---|---|
| R1 | Full LLM rewrites cause **context collapse**; over-summarizing causes **brevity bias** (ACE) | Never rewrite the vault wholesale. Only add / edit / merge **atomic notes**. |
| R2 | Retrieve by **similarity × utility**, not similarity alone (MemRL) | Every note carries `q_value`; ranking = similarity × Q × validity. |
| R3 | `Q ← Q + α·c·(r − Q)` from task outcomes, contribution-weighted (TAME) | Post-task scorer updates Q only for notes actually injected. |
| R4 | Typed learnings with provenance beat raw logs (IBM Trajectory Memory) | Reflector emits typed notes (`recovery/strategy/optimization/decision/convention`) with commit/file provenance. |
| R5 | Verifiable feedback (tests/build) + capped LLM judge beats judge-only (CODESKILL) | Anchor reward `r` on tests passing / build green / no rollback. |
| R6 | Sleep-time consolidation beats lazy in-session updates (Letta, AutoDream) | Nightly "dream" job: merge, resolve contradictions, decay, archive. |
| R7 | Forgetting is required — decay + caps → size plateaus (SCM) | Decay Q on unused notes; archive below threshold; ~300 active notes/repo cap. |
| R8 | Atomic linked notes (Zettelkasten) outperform raw chunks (A-MEM) | Vault = Obsidian-style atomic notes with wikilinks + entity hubs. |
| R9 | Track **stale retrieval rate** as a first-class metric (SleepGate) | Log every injected note per session; target < 5%. Shown on dashboard. |
| R10 | Model-chosen tool recall is unreliable; MCP definitions cost tokens (memsearch) | **Push** top-k at SessionStart via hook stdout. MCP search is secondary. |
| R11 | A/B eval works headlessly: `claude -p` ± memory (codegraph) | Eval harness ships in Phase 2, `MEMORY_OFF=1` is the control arm. |
| R12 | Hooks must return fast; reflection takes 5–30 s (claude-mem) | SessionEnd hook only **enqueues**; a background worker reflects. |

Full source list in §9 References.

---

## 4. System Architecture

```
┌──────────────────────────  unified_mem  (this repo = knowledge vault)  ──────────────────────────┐
│  notes/YYYY/MM/*.md        atomic typed notes (Obsidian-compatible)                              │
│  entities/*.md             hub pages per entity (Phase 4)                                        │
│  queue/*.json              raw session refs awaiting reflection                                  │
│  index/vault.db            SQLite (node:sqlite): notes · sessions · injections · q_history ·     │
│                            consolidations · metrics_daily                                        │
│  scripts/                  vault.mjs · seed.mjs · retrieve.mjs · enqueue.mjs · dashboard.mjs     │
│  dashboard/                index.html (self-contained UI) · vendor/ (Prism)                      │
│  eval/                     questions.yaml per repo · run.sh · results/   (Phase 2)               │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
         ▲ write (reflector, scorer, consolidator)              │ read (retriever, dashboard)
         │                                                      ▼
┌────────── async worker (background) ─────────┐   ┌────────── Claude Code session ───────────┐
│ Reflector  : transcript → 1–5 typed notes    │   │ SessionStart hook → top-k notes injected  │
│ Scorer     : outcome → Q updates             │   │ (optional) MCP vault_search on demand     │
│ Consolidator (nightly "dream"):              │   │ SessionEnd hook → enqueue for reflection  │
│   merge · contradict-resolve · decay ·       │   └───────────────────────────────────────────┘
│   archive · git-diff invalidation            │                      │ every event lands in vault.db
└──────────────────────────────────────────────┘                      ▼
                                            ┌──────────── live dashboard :7777 ────────────┐
                                            │ Sessions · Notes graph · Q evolution ·        │
                                            │ Consolidation (Prism diffs) · Metrics         │
                                            └───────────────────────────────────────────────┘
```

### 4.1 Note schema (one claim per note, ≤150-word body)

```yaml
---
id: 2026-07-07-jwt-refresh-race          # date-slug, stable
type: recovery        # strategy | recovery | optimization | decision | convention
title: JWT refresh race causes 401 bursts under load
entities: [auth-service, jwt, redis]
repos: [api-core, auth-service]
files: [src/auth/token.ts, src/middleware/refresh.ts]
source_commit: 8f3ab21
confidence: high      # high | med | low
q_value: 0.50         # learned usefulness, starts neutral
access_count: 0
last_used: null
last_validated: 2026-07-07
status: active        # active | needs-review | archived
links: ["[[redis-lock-pattern]]", "[[auth-service]]"]
---
**Problem:** ...  **Root cause:** ...  **Fix:** ... (commit)  **Gotchas:** ...
```

Rules: one claim per note (R8); factual voice (avoids prompt-injection defenses); provenance mandatory (R4); no secrets — reflector prompt forbids them and enqueue greps for key patterns.

### 4.2 Retrieval ranking

```
score(note) = 0.40·similarity + 0.30·q_value + 0.15·recency + 0.15·validity
validity    = 1.0 active · 0.4 needs-review (injected with "verify against code" label) · 0 archived
```

- **Push path (primary, R10):** SessionStart hook builds a query from `{repo name, branch, last 5 commit subjects, changed paths}` → top **5 notes / ≤2,500 tokens** → stdout → injected as context, prefixed *"Team knowledge notes from past sessions (verify against current code before relying on them):"*
- **Pull path (secondary, Phase 2+):** MCP `vault_search(query, entity?, repo?)`.
- Every injection is logged `(session_id, note_id, rank, score)` — the scorer, the staleness metric, **and the dashboard Sessions view** all read this log.
- *Skeleton note:* similarity is keyword-overlap scoring in `vault.mjs` for now; FTS5/embeddings replace it in Phase 2 behind the same function.

### 4.3 The evolution loop

```
GENERATE ──► REFLECT ──► CURATE ──► SCORE ──► CONSOLIDATE ──► MEASURE
(session)   (worker,     (delta     (Q update  (nightly        (weekly A/B
             typed notes) inserts)   outcome)   dream job)      + dashboard)
```

**Score update (R3, R5):**
```
r = 1 verifiable success (tests pass / build green, no revert) · 0 verifiable failure · skip if indeterminate
c = contribution ∈ [0,1] from a cheap LLM judge
Q ← clamp(Q + 0.3·c·(r − Q), 0.05, 0.95);  |ΔQ| ≤ 0.15 per session   # anti-gaming cap
```

**Decay & forgetting (R7):** weekly `Q ← Q·0.95^weeks_unused`; archive when `Q < 0.20` and unused 60 days; hard cap ~300 active notes per repo.

**Invalidation (R9):** nightly, any note whose `files:` changed since `last_validated` → `status: needs-review`. Survives verification → back to active with new provenance; else archived. **The single biggest accuracy lever** — converts silent staleness into a visible review queue (surfaced as an amber badge on the dashboard).

### 4.4 Visualization layer — *watch the memory work* (NEW)

One zero-dependency Node server (`scripts/dashboard.mjs`, stdlib `node:http` + `node:sqlite`) serving one self-contained page (`dashboard/index.html`) on **http://localhost:7777**. Polls `/api/state` every 5 s — the page is live: run a Claude Code session in a wired repo and watch the injection appear.

Every memory mechanism maps to a view:

| View | Mechanism it makes visible | What you see |
|---|---|---|
| **Sessions** | Push-path retrieval + scoring (R2, R3, R10) | Timeline of sessions: repo, outcome badge (✓ success / ✗ failure / ○ indeterminate), token budget used, each injected note with rank, score, and **Q delta (▲/▼)** it earned from that session's outcome |
| **Notes graph** | Atomic linked notes (R8) | Force-directed graph: note nodes colored by type, sized by q_value, linked to shared entity hubs and wikilinks; amber ring = needs-review |
| **Q evolution** | Utility learning + decay (R2, R3, R7) | Multi-line chart of q_value per note over sessions — rising lines = notes that keep helping, sagging lines = decay of unused notes, flat-lining into archive |
| **Consolidation** | Dream job: merge / edit / invalidate / archive (R1, R6, R9) | Operation log; **every merge and edit shows a Prism `diff-highlight` view** of exactly what changed in the note — before/after, red/green |
| **Metrics** | Accuracy targets (§6) | Stat tiles: active notes, needs-review, **stale retrieval rate (<5% target)**, mean Q; vault size trend chart (must plateau, not grow linearly — R7) |

Design system: dataviz-skill reference palette, dark surface `#1a1a19` / page `#0d0d0d`; categorical dark slots validated (`validate_palette.js --mode dark`: PASS, CVD floor band → legend + direct end-labels mandatory on multi-series charts); status colors (good `#0ca30c`, warning `#fab219`, critical `#d03b3b`) reserved for outcomes/staleness, never series. 2px lines, ≥8px end-dots with 2px surface rings, hairline gridlines, hover tooltips + crosshair, `<details>` data table under each chart.

**Diff views:** Prism core + `prism-diff` + `diff-highlight` plugin (vendored in `dashboard/vendor/`, offline-capable). The consolidator writes a unified diff string into `consolidations.diff` for every merge/edit/verify op; the dashboard renders it as `language-diff-highlight`. Same component later renders "what changed in the code that invalidated this note" (git diff excerpt) — Phase 3.

---

## 5. Claude Code Integration

### 5.1 Hooks — per consuming repo's `.claude/settings.json`

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command",
      "command": "node \"/path/to/unified-mem/scripts/retrieve.mjs\"", "timeout": 10 }] }],
    "SessionEnd":   [{ "hooks": [{ "type": "command",
      "command": "node \"/path/to/unified-mem/scripts/enqueue.mjs\"", "timeout": 5 }] }]
  }
}
```

- `retrieve.mjs`: reads hook JSON on stdin (`session_id`, `cwd`), queries the vault, prints top-k notes (factual voice) to stdout → injected context. Logs the injection. `MEMORY_OFF=1` → silent exit (eval control arm).
- `enqueue.mjs`: writes `queue/<session_id>.json` in <100 ms and exits 0 (R12). Background worker drains the queue.
- Exit codes: 0 = stdout injected; 1 = non-blocking failure (memory never blocks a session).

### 5.2 Reflector (worker runs headless `claude -p`)

Distills a completed session into 0–5 typed notes (fewer is better); only durable reusable knowledge; forbids secrets/PII/speculation; prefers editing an existing note over near-duplicating (10 nearest notes provided in-prompt); every note cites commit + files. Full prompt lands in `scripts/worker/` in Phase 1.

### 5.3 Nightly consolidation "dream" job (cron → headless subagent)

Incremental ops ONLY (merge richest-detail, contradictions → newest commit wins + `superseded_by`, git-diff invalidation → needs-review, verify up to 10, decay + archive + cap, update entity hubs). **Every op writes a row to `consolidations` with a unified diff** — that's what the dashboard's Prism view renders. Manual trigger after big migrations.

### 5.4 CLAUDE.md wiring (each consuming repo)

```md
## Team knowledge
Cross-repo knowledge notes are injected at session start. Treat them as strong
hints, not ground truth — verify against current code, especially notes labeled
"needs-review". When you discover a durable fix or decision, state it clearly
in your final summary so the reflector can capture it.
```

---

## 6. Evaluation Plan

**Harness (R11):** `eval/run.sh`, 15–20 real tasks per repo via headless `claude -p`. Arm A memory on, Arm B `MEMORY_OFF=1`, 4 runs/arm, medians.

| Metric | Source | Target | Dashboard |
|---|---|---|---|
| Task success A vs B | eval harness | A ≥ B + 10 pts by Phase 3 | Metrics |
| Tokens & cost per task | `claude -p` totals | A < B on knowledge tasks | Metrics |
| **Stale retrieval rate** | injection log × supersessions | **< 5%** | Stat tile |
| Redundancy | consolidator report | < 10% | Stat tile |
| Vault size trend | metrics_daily | plateaus, not linear | Trend chart |
| Note usefulness (dev thumbs) | `/vault-feedback` | ≥ 70% useful | Sessions |
| Q-calibration | useful vs not mean Q | separated ≥ 0.2 | Q evolution |

**Decision rule:** no significant A-arm win after 4 weeks of Phase 3 → fix retrieval precision and reflector selectivity before adding machinery.

---

## 7. Phased Roadmap

| Phase | Time | Build | Exit criteria |
|---|---|---|---|
| **0 — Seed + See** ✅ *scaffolded today* | Days 1–3 | Vault repo, schema, seed notes, `retrieve/enqueue` hooks, **live dashboard with seeded demo history** | Dashboard shows the full loop on demo data; Claude Code visibly uses seed notes in 3 real sessions |
| **1 — Capture** | Wk 1–2 | Worker + reflector prompt; secrets grep; real sessions start replacing seed data on the dashboard | ≥70% of auto-notes rated useful; zero secrets |
| **2 — Retrieval + Eval** | Wk 3–4 | FTS5 + embeddings behind `scoreNotes()`; injection logging already live; eval harness; optional `vault_search` MCP | A/B: fewer tokens/file-reads, no success regression |
| **3 — Evolution** | Wk 5–8 | Scorer + Q updates; nightly dream job writing real consolidation diffs; git-diff invalidation; decay | Stale-retrieval <5%; size plateaus; A ≥ B +10 pts |
| **4 — Scale & Team** | Ongoing | Entity hubs; team sharing via git PRs; evaluate Cipher/ByteRover + codebase-memory-mcp; Graphiti only if >5k notes | Second team onboarded; cross-repo reuse counted |

**Adopt vs build:** adopt claude-mem patterns + codebase-memory-mcp + embedding libs; build only reflector prompts, schema, Q-scoring, invalidation, consolidation, eval harness, dashboard (~thin glue).

---

## 8. Risks & Guardrails

| Risk | Mitigation |
|---|---|
| Stale memory misleads the model | Git-diff invalidation → needs-review; "verify against code" framing; stale-rate tile with <5% target |
| Context collapse / brevity bias | Incremental note ops only; merges keep richest detail |
| Score gaming | Verifiable-outcome anchor; ΔQ cap ±0.15; clamp 0.05–0.95; Q-calibration check |
| Vault noise growth | Reflector selectivity; dedupe-before-create; decay + 300-note cap |
| Secrets leakage | Prompt prohibition + regex scan in enqueue/worker; private repo |
| Token bloat | 2.5k-token injection budget, k=5; MCP pull opt-in |
| Write races | Single worker writes notes; hooks write per-session queue files |
| Ambiguous outcomes | Indeterminate → skip Q update, neutral decay only |
| Hook latency | Retrieval <10 s local SQLite; reflection fully async |
| Injection-defense misfires | Injected text = factual statements, never imperatives |

---

## 9. References

**Research:** ACE arxiv.org/abs/2510.04618 · MemRL (effloow.com) · TAME arxiv.org/pdf/2602.03224 · IBM Trajectory Memory arxiv.org/pdf/2603.10600 · CODESKILL arxiv.org/html/2605.25430 · SCM arxiv.org/abs/2604.20943 · SleepGate arxiv.org/html/2603.14517v1 · A-MEM survey arxiv.org/pdf/2606.24937 · Letta letta.com/blog/agent-memory

**Tools:** claude-mem github.com/thedotmack/claude-mem · AutoDream (zenvanriel.com) · memsearch (milvus.io) · codebase-memory-mcp github.com/DeusData/codebase-memory-mcp · codegraph github.com/colbymchenry/codegraph · Graphify (dev.to) · Cipher/ByteRover · Mem0 docs.mem0.ai/integrations/claude-code · Neo4j create-context-graph · Graphiti github.com/getzep/graphiti

**Platform:** code.claude.com/docs/en/hooks · docs.claude.com/en/docs/claude-code/overview · platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool

---

