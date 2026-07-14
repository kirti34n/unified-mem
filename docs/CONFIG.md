# Config reference

Config lives at `~/.unified-mem/config.json`, which `node scripts/init.mjs` writes for you; the stable home location is what lets it survive plugin updates, which replace the install directory. A `config.json` inside the tool checkout is still honored and takes precedence, for pre-split manual installs. Copy `config.example.json` to whichever of the two you use; defaults apply for anything omitted. Repos auto-register: the first session you open in any git repo adds it to the `repos` map and writes an instant repo card.

| Key | Default | What it does |
|---|---|---|
| `vault_dir` | `~/.unified-mem/vault` | where your data lives (its own git repo). Env override `UNIFIED_MEM_VAULT_DIR` wins (used by tests); a legacy `./notes` dir inside the tool checkout is still honored for pre-split installs |
| `weights` | `.40/.30/.15/.15` | similarity / q_value / recency / validity ranking mix (normalized at load) |
| `k` | `5` | max notes injected at session start |
| `max_inject_chars` | `10000` | session-start injection budget (about 2,500 tokens). It also bounds the per-prompt injection, which uses min(max_inject_chars, 6000) characters, so raising it above 6000 has no effect there |
| `start_min_sim` | `0.2` | session-start relevance floor |
| `prompt_k` / `prompt_min_sim` | `2` / `0.15` | per-prompt injection count and floor (plus the rare-term gate) |
| `recency_half_life_days` | `30` | recency decay in ranking |
| `decay_factor_per_week` / `decay_after_unused_days` | `0.95` / `7` | Q decay on idle notes |
| `archive_below_q` / `archive_unused_days` | `0.20` / `60` | forgetting policy |
| `active_cap_per_repo` | `300` | cap on active non-preference notes per repo. When consolidation finds a repo above it, it archives the overflow (lowest `q_value` first, oldest `last_used` breaking ties) until that repo is back at the cap. Preference notes are never auto-archived and do not count toward the cap, so the separate `OVER CAP (residual after enforcement)` warning, which counts every active note including preferences, can still fire afterwards |
| `q_alpha` / `q_delta_cap` / `q_clamp` | `0.3` / `0.15` / `[.05,.95]` | Q-update guardrails |
| `contribution_judge` | `llm` | `llm` for the pinned judge, `heuristic` for zero LLM calls |
| `daily_budget_usd` | `5` | hard daily cap on pipeline LLM spend (reflect, judge, verify, arbiter, and the eval harness) |
| `max_reflections_per_run` | `10` | reflections per worker drain; excess stays queued for the next run |
| `reflect_cooldown_min` | `20` | minutes a session stays reflect-suppressed after a paid reflect call, so a PreCompact + SessionEnd (or `--watch`) re-enqueue of the same session does not re-bill the reflector |
| `reflector_model` | sonnet | model that writes notes (quality matters here) |
| `eval_model` / `verify_model` | haiku | cheap pinned models for eval, verification, judging |
| `verify_cap` | `5` | max needs-review notes verified per consolidation run |
| `personal_budget_chars` | `800` | budget for the pinned PERSONAL PREFERENCES block at session start |
| `preference_cap` | `30` | warn above this many active preferences (each one is pinned into every session) |
| `repos` | `{}` | name-to-local-path map powering staleness invalidation and repo cards |
| `disabled_repos` | `[]` | repos where memory is switched off (no injection, no capture); toggle from the dashboard Repos view |

## Environment variables

| Variable | Effect |
|---|---|
| `UNIFIED_MEM_VAULT_DIR` | overrides `vault_dir` (tests, scratch experiments) |
| `MEMORY_OFF=1` | disables all injection and capture (the eval control arm) |
| `UNIFIED_MEM_NO_CAPTURE=1` | injection works but nothing is logged, mutated, or enqueued (eval arm A, internal calls) |
| `UNIFIED_MEM_DEBUG=1` | hook errors, normally swallowed by design, are appended to `<vault>/index/hook-errors.jsonl` |
| `UNIFIED_MEM_NO_FTS=1` | forces the keyword-scoring fallback instead of FTS5/BM25 (auto-detected; set this only to test the fallback path) |

**Note on Node and FTS5:** the code runs on Node 22.13+ (`node:sqlite`), but FTS5/BM25 ranking needs a Node build whose bundled SQLite includes FTS5 (Node 24.x does; the 22.13 baseline does not). Where FTS5 is missing, retrieval automatically degrades to keyword scoring, so everything still works, just a little less precisely.
