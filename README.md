<div align="center">

# 🧠 unified-mem

**A cross-repo evolving memory system for Claude Code.**

Every session starts cold. This fixes that — permanently, across *all* your repositories.

[![Zero Dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen)](#-quickstart-5-minutes)
[![Node 22.5+](https://img.shields.io/badge/node-%E2%89%A522.5-blue)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Claude Code](https://img.shields.io/badge/built%20for-Claude%20Code-d97757)](https://code.claude.com)

<img src="docs/screenshots/sessions.png" width="85%" alt="Live dashboard — sessions view">

*The live dashboard: every session, what the vault injected, and the usefulness score each note earned from the outcome.*

</div>

---

## 🧭 What is this, in plain words?

When you use Claude Code, each conversation ("session") starts with **no memory** of previous ones. You spend an afternoon hunting down a nasty bug, the session ends, and tomorrow — in the same repo or a different one — Claude has to rediscover everything from scratch.

**unified-mem is a shared notebook that all your sessions write to and read from.**

- When a session **ends**, a background worker reads the transcript and writes down anything durable it learned — *"this bug had this fix"*, *"this project follows this convention"*, *"this approach worked"* — as small markdown files called **notes**.
- When a new session **starts** (in *any* of your repositories), the most relevant notes are automatically shown to Claude before it begins. It starts the day already knowing what you learned last week, in every repo.
- Over time the system **grades its own notes**. Notes that keep showing up in successful sessions gain a usefulness score (Q-value); notes nobody benefits from fade away and are archived. When the code a note describes gets changed, the note is flagged *"needs review"* and re-verified against the code — so old advice can't silently mislead you. **Stale memory is worse than no memory**, so forgetting is a feature, not a bug.

Everything is observable on a **live dashboard** — you can literally watch what got injected, which notes are earning their keep, and every change the maintenance job makes (shown as red/green diffs).

No databases to install, no npm packages, no cloud. Plain markdown files + Node's built-in SQLite. The vault is a git repo you own.

## 🤔 The problem, precisely

1. **Session amnesia** — every Claude Code session starts from zero. Yesterday's debugging is gone.
2. **Cross-repo blindness** — a fix discovered in `repo-A` gets re-discovered from scratch in `repo-B`.
3. **No learning loop** — even where notes exist (CLAUDE.md), nothing measures whether they *help*, and nothing removes what's stale.

```mermaid
flowchart LR
    subgraph session [Claude Code session — any repo]
        A[SessionStart hook<br/>retrieve.mjs] -->|top-5 notes injected| B((session runs))
        B --> C[SessionEnd hook<br/>enqueue.mjs]
    end
    C -->|queue/| D[worker.mjs<br/>outcome scorer + reflector]
    D -->|new notes| V[(vault<br/>notes/*.md + SQLite FTS5)]
    V --> A
    N[consolidate.mjs<br/>nightly dream job] -->|decay · archive · invalidate<br/>· verify against code| V
    M[mcp-server.mjs<br/>vault_search] -.->|optional mid-session pull| B
    E[eval/run.mjs<br/>A/B harness] --> I[improve.mjs<br/>self-improvement loop]
    I -->|tunes| K[config.json]
    K --> A
```

## ⚡ Quickstart (5 minutes)

**Prerequisites:** [Node.js](https://nodejs.org) ≥ 22.5 (`node --version` to check — the built-in SQLite arrived in 22.5) and the [Claude Code CLI](https://code.claude.com). That's it — **zero npm installs**.

**Step 1 — See it working before committing to anything.** The demo seeds three weeks of fictional history so every dashboard view has data:

```bash
git clone https://github.com/kirti34n/unified-mem && cd unified-mem
node scripts/seed.mjs        # builds the demo vault
node scripts/dashboard.mjs   # → open http://localhost:7777 and click through the 5 views
```

**Step 2 — Attach it to your sessions.** Add two hooks to `~/.claude/settings.json` (create the file if it doesn't exist; if you already have a `"hooks"` section, merge these keys into it). Replace `/path/to/unified-mem` with where you cloned it:

```jsonc
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command",
      "command": "node \"/path/to/unified-mem/scripts/retrieve.mjs\"", "timeout": 10 }] }],
    "SessionEnd":   [{ "hooks": [{ "type": "command",
      "command": "node \"/path/to/unified-mem/scripts/enqueue.mjs\"", "timeout": 5 }] }]
  }
}
```

Because this lives in your **user-level** settings, it applies to *every* repository automatically — including ones you create next month.

**Step 3 — Turn on the learning loop.**

```bash
node scripts/worker.mjs --watch     # keep running: reflects finished sessions into notes
node scripts/consolidate.mjs       # run nightly (cron / Task Scheduler): the "dream job"
```

**Step 4 (optional but recommended) — Import your history.** Mine the session transcripts you *already have* into notes, so the vault starts useful instead of empty:

```bash
node scripts/backfill.mjs --per-repo 2   # queue your 2 biggest recent transcripts per repo
node scripts/worker.mjs                  # reflect them into notes
node scripts/seed.mjs --purge-demo       # drop the demo rows, keep only real data
```

**Step 5 — Tell the maintenance job where your repos live** (this powers staleness detection). Copy `config.example.json` to `config.json` and fill in the `repos` map:

```jsonc
"repos": { "my-api": "/home/me/code/my-api", "my-app": "/home/me/code/my-app" }
```

That's the whole install. From now on, sessions begin with *"Team knowledge notes from past sessions…"* and end by feeding the vault.

## 📓 What a note looks like

One claim per note, ≤150 words, plain markdown with YAML frontmatter — the whole vault opens in [Obsidian](https://obsidian.md) if you like graphs:

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
q_value: 0.50         # learned usefulness — starts neutral, earned over time
status: active        # active | needs-review | archived
links: ["[[2026-06-16-redis-lock-pattern]]"]
---
**Problem:** Parallel requests refreshing the same expired JWT raced...
**Root cause:** No mutual exclusion around token rotation.
**Fix:** Redis SETNX lock keyed by user-id (commit 8f3ab21). 50ms retry, 5s TTL.
**Gotchas:** Lock TTL must exceed p99 refresh latency.
```

The `files:` + `source_commit` provenance is not decoration — it's what lets the system later detect that the code a note describes has changed.

## 🖥️ The dashboard

Five views, each making one mechanism visible:

<details>
<summary><b>📋 Sessions</b> — what was injected into each session, and the Q-delta each note earned from the outcome</summary>
<br><img src="docs/screenshots/sessions.png" alt="Sessions view">
</details>

<details>
<summary><b>🕸️ Notes graph</b> — atomic notes linked through shared entities, sized by learned Q-value</summary>
<br><img src="docs/screenshots/graph.png" alt="Notes graph view">
</details>

<details>
<summary><b>📈 Q evolution</b> — usefulness being learned: rising lines help, sagging lines decay toward archive</summary>
<br><img src="docs/screenshots/q-evolution.png" alt="Q evolution view">
</details>

<details>
<summary><b>🌙 Consolidation log</b> — every merge/edit/invalidation/verification as an exact red/green diff</summary>
<br><img src="docs/screenshots/consolidation.png" alt="Consolidation view">
</details>

<details>
<summary><b>🎯 Metrics</b> — stale-retrieval rate (&lt;5% target), vault size trend (healthy = plateau, broken = linear growth)</summary>
<br><img src="docs/screenshots/metrics.png" alt="Metrics view">
</details>

## 🔬 How it works (the mechanisms)

<details>
<summary><b>1. Retrieval — which notes get injected?</b></summary>

At session start, a query is built from your repo name, branch, last 5 commit subjects, and recently changed paths. Every note is scored:

```
score = 0.40·similarity + 0.30·q_value + 0.15·recency + 0.15·validity
```

- **similarity** — SQLite FTS5/BM25 full-text match (no embeddings needed at this scale)
- **q_value** — the learned usefulness score (see below)
- **recency** — exponential half-life, default 30 days
- **validity** — `active 1.0 · needs-review 0.4 · archived 0` (a needs-review note can still appear, but demoted and explicitly labeled *"verify against code"*)

Top-5 notes, capped at ≈2,500 tokens, written as factual statements — never imperative commands (out-of-band imperative text can trip Claude's prompt-injection defenses). Retrieval is **pushed** by the hook rather than waiting for the model to think of searching — model-initiated recall is unreliable, and injected context is free of per-turn tool-definition overhead.
</details>

<details>
<summary><b>2. Reflection — where notes come from</b></summary>

The SessionEnd hook only *enqueues* (hooks must return in milliseconds). A background worker then reads the transcript and asks a headless Claude to distill it: only durable, reusable knowledge; typed (`recovery`/`strategy`/`optimization`/`decision`/`convention`); one claim per note; commit + files provenance mandatory; secrets forbidden by prompt **and** regex-scanned again before the file is written; near-duplicates suppressed by showing the reflector the 10 nearest existing notes. "Zero notes" is a valid and common outcome — routine sessions produce nothing, and that's correct.
</details>

<details>
<summary><b>3. Q-learning — how usefulness is earned</b></summary>

The worker detects a **verifiable outcome** for each session — tests passed / build green → `r=1`; failed → `r=0`; anything unclear → *no update at all* (never guess rewards). Every note that was injected into that session gets:

```
Q ← clamp(Q + α·c·(r − Q), 0.05, 0.95)      α=0.3, |ΔQ| ≤ 0.15 per session
```

where `c` ∈ [0,1] measures whether the note's content surfaced in the **assistant's own output** — matching the whole transcript would reward notes merely for being injected, a self-reinforcing loop. Guardrails (clamp, per-session cap, verifiable-outcome anchor, and a deliberately conservative outcome detector — a bare ✓ is not a success signal) keep scores honest. Unused notes decay `Q·0.95^weeks`; below 0.20 and unused 60 days → archived. The vault size **plateaus** instead of growing forever — that trend line is on the Metrics view, and if it's linear, forgetting is broken.
</details>

<details>
<summary><b>4. Staleness — the biggest accuracy lever</b></summary>

Nightly, for every active note: if any file in its `files:` list has commits since the note's `last_validated` (checked with `git log` against your local clones), the note drops to **needs-review**. Then a verification pass reads the *current* code and decides: claims still hold → restored to active with fresh provenance; code moved on → archived, with the reason logged. Every step appears in the Consolidation view as a diff. This converts the worst failure mode of any memory system — confidently applying outdated fixes — into a visible, self-healing review queue.
</details>

<details>
<summary><b>5. Mid-session search (optional MCP pull path)</b></summary>

Injection covers session start; for mid-session lookups there's a zero-dependency MCP server exposing `vault_search(query, repo?, k?)`:

```bash
claude mcp add --scope user vault-search -- node /path/to/unified-mem/scripts/mcp-server.mjs
```

Opt-in by design — MCP tool definitions cost tokens in every session, so only register it if you find yourself wanting mid-session recall.
</details>

<details>
<summary><b>6. Measurement — prove it helps, don't assume</b></summary>

```bash
node eval/run.mjs --runs 4        # arm A: memory on · arm B: MEMORY_OFF=1 control
```

Same questions through headless `claude -p`, graded by expect-regex, reported as correct-rate / tokens / latency medians per arm. In this project's smoke eval, arm A answered 3/3 questions whose answers existed *only* in vault notes; arm B scored 0/3. Honest caveat: those questions were written from the notes, so they demonstrate the plumbing works end-to-end (injection → context → answer), not a field result. Write questions from *your* real incidents into `eval/questions.json` — that also makes the improve loop meaningful.
</details>

<details>
<summary><b>7. The self-improvement loop</b></summary>

```bash
node scripts/improve.mjs --iterations 5    # or --forever; create a STOP file to halt
```

`RESEARCH → HYPOTHESIS → IMPLEMENT → TEST → ACCEPT/REVERT → repeat.` Hill-climbs the retrieval tunables (weights, k, half-life, token budget) against the A-arm eval score, one knob at a time. A noise guard rejects same-noise deltas: a change is accepted only if correctness strictly improves, or ties with ≥15% fewer output tokens — run-to-run jitter cannot alter your config. (Ranking weights are also normalized at load, so no config change can break the weighting invariant.) Runs as a plain Node process spawning fresh headless `claude -p` calls — no CLI session limits apply. Every iteration logs to `improve/log.jsonl`. **Use enough eval questions/runs that deltas beat noise** — with 3 questions × 1 run, accept/revert decisions are jitter; ~15 questions × 4 runs is where it gets meaningful.
</details>

## ⚙️ Config reference

Copy `config.example.json` → `config.json` (defaults apply for anything omitted):

| Key | Default | What it does |
|---|---|---|
| `weights` | `.40/.30/.15/.15` | sim / q / recency / validity ranking mix |
| `k` | `5` | notes injected per session |
| `max_inject_chars` | `10000` | ≈2,500-token injection budget |
| `recency_half_life_days` | `30` | recency decay in ranking |
| `decay_factor_per_week` / `decay_after_unused_days` | `0.95` / `7` | Q decay on unused notes |
| `archive_below_q` / `archive_unused_days` | `0.20` / `60` | forgetting policy |
| `q_alpha` / `q_delta_cap` / `q_clamp` | `0.3` / `0.15` / `[.05,.95]` | Q-update guardrails (anti-gaming) |
| `reflector_model` | sonnet | model that writes notes (quality matters here) |
| `eval_model` / `verify_model` | haiku | cheap models for eval & verification |
| `verify_cap` | `5` | max needs-review notes verified per consolidation run |
| `repos` | `{}` | `name → local path` map powering git-diff invalidation |

## 🧯 Troubleshooting & FAQ

<details>
<summary><b>Notes aren't being injected</b></summary>

- Hooks only apply to sessions started *after* editing settings — open a fresh session.
- Test the retriever directly: `echo '{"session_id":"t","cwd":"/path/to/some/repo"}' | node scripts/retrieve.mjs` — you should see notes on stdout.
- `MEMORY_OFF=1` in your environment silences it by design (that's the eval control arm).
- The hook never blocks a session: on any internal error it exits 0 silently. Run the command above manually to surface the error.
</details>

<details>
<summary><b>The worker writes no notes</b></summary>

Usually correct behavior — routine sessions contain nothing durable, and the reflector is told "fewer is better; 0 is valid." It also drops any note matching secret patterns, and skips near-duplicates of existing notes. Check `queue/` is being drained and look at the worker's stdout.
</details>

<details>
<summary><b>Does my code or transcript data leave my machine?</b></summary>

Only through the same channel you already use: headless `claude -p` calls (reflection, verification, eval) go to the same API as your normal Claude Code sessions. Notes never leave the vault directory; the dashboard binds to localhost; there's no telemetry.
</details>

<details>
<summary><b>Won't the vault fill up with junk?</b></summary>

That's what the forgetting machinery is for: reflector selectivity in, decay + archival out, per-repo active cap (default 300), dedupe-candidate flagging in between. Watch the vault-size trend on the Metrics view — plateau is healthy, linear growth means something's off.
</details>

<details>
<summary><b>Can a weird session poison the vault?</b></summary>

Defenses in order: transcripts are wrapped as *data* in the reflector prompt; reflector output passes a **schema gate** (valid id format, title, body, and one of the five allowed types — anything malformed is dropped); notes are written in factual voice (never instructions); secrets are regex-blocked; new notes start at neutral Q and must *earn* influence through successful sessions; injections tell Claude to verify against current code; and everything is a git-tracked markdown file you can diff, revert, or delete. Treat the vault like code — review what lands in it, especially before sharing a vault with a team.
</details>

<details>
<summary><b>Windows notes</b></summary>

Built and tested on Windows 11 (Git Bash present). Hook commands use forward slashes and quoted absolute paths, which work across platforms. For scheduled runs use Task Scheduler:
`schtasks /Create /SC DAILY /ST 03:00 /TN unified-mem-dream /TR "node C:\path\to\unified-mem\scripts\consolidate.mjs"`
</details>

## 📚 Research foundations

The design rules are distilled from published work: **ACE** (evolving playbooks; context-collapse & brevity-bias failure modes — hence incremental note ops, never wholesale rewrites) · **MemRL / TAME** (similarity × utility retrieval; contribution-weighted Q updates) · **CODESKILL** (verifiable rewards beat LLM-judge-only) · **SCM / Letta** (sleep-time consolidation; ~30% redundancy by session 10 without it) · **SleepGate** (stale-retrieval rate as a first-class metric) · **A-MEM** (Zettelkasten-style atomic linked notes beat raw chunks). Full citations and the complete design document: [docs/PLAN.md](docs/PLAN.md).

## 🗺️ Roadmap

- [x] Push-path injection, FTS5/BM25 retrieval, injection logging
- [x] Reflection worker + verifiable-outcome Q scorer
- [x] Nightly consolidation: decay · archive · git-diff invalidation · dedupe flagging
- [x] LLM verify-pass: needs-review notes checked against current code, restored or archived
- [x] MCP `vault_search` tool for mid-session pull (opt-in)
- [x] Live dashboard with Prism diff views
- [x] A/B eval harness + self-improvement loop
- [x] Transcript backfill (mine past sessions into notes)
- [ ] Embeddings behind `scoreNotes()` (when FTS5 precision measurably fails)
- [ ] LLM contribution judge for Q updates (heuristic term-overlap today)
- [ ] Entity hub pages & team sharing via git PRs

## 📄 License

[MIT](LICENSE)
