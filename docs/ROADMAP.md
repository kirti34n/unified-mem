# Roadmap

- [x] Cold-start catalog plus nightly repo cards: sessions start with a map, not a data dump
- [x] Session-start injection with relevance floor, FTS5/BM25 retrieval, injection logging
- [x] Per-prompt just-in-time retrieval with session dedupe and a frequency-aware precision gate
- [x] Reflection worker with verbatim-detail rule, schema gate, and capture guards against cost loops
- [x] Outcome scorer with pinned LLM contribution judge
- [x] Nightly consolidation: decay, archive, git-diff invalidation, verify-pass with backoff
- [x] Contradiction arbiter: near-duplicate pairs classified duplicate / update / coexisting
- [x] Entity hub pages and repo cards regenerated nightly
- [x] MCP `vault_search` tool for explicit pull (opt-in)
- [x] Live dashboard with Prism diff views
- [x] A/B eval harness (per-question cwd, negative probes, real-set defaults) and gated improve loop
- [x] Transcript backfill
- [x] Cost engineering: per-call ledger, hard daily budget, tier routing, reflection cap per drain
- [x] Auto-linked knowledge graph (co-file and shared-entity edges, no embeddings)
- [x] Telemetry: abstention rate on the dashboard, vault-gap log for unmatched technical prompts
- [x] Provenance stamping on every note (author, machine, session, trust class)
- [x] Personal layer: pinned preferences (vault_remember MCP tool, remember.mjs CLI) and hash-tracked reference docs (ingest.mjs), scope-aware schema with reflector poisoning boundary
- [x] Situation-keyed retrieval (`triggers`): situation phrases in the user's words, indexed as a high-weight FTS column, so a prompt matches on when a note applies, not just its solution text
- [x] Pitfall/guidance polarity: pitfall notes render in a separate "do NOT repeat" injection block (negative-example framing)
- [x] Adaptive-k retrieval (cut at a score cliff instead of padding to k) and PreCompact mid-session capture (queue detail before context is summarized away)
- [x] Offline retrieval-weight fitting (`tune-weights.mjs`) from logged injection outcomes; rationale-first fail-closed contribution judge
- [x] Starter vault of curated generic gotchas (`starter.mjs`, `trust: seed`, self-retiring as your own notes accumulate)
- [x] Capture the work, not just the narration: the reflector reads the commands that ran and the code the edits installed, on an enriched transcript projection, while the reward keeps reading a byte-frozen lean one so past Q values stay comparable
- [x] The arbiter's verdict is executed: a superseded note gains a `superseded_by:` pointer and retrieval serves its replacement's content in its slot. Demotion alone provably cannot work, since the stale note is usually the strongest match for the query it answers
- [x] Free, deterministic, LLM-free retrieval eval (`eval/negatives.mjs`, in CI): does memory stay quiet when it should? Guards the failure the paid eval is structurally blind to
- [x] Single-writer lock on the nightly job (under concurrency the two-strike verify rule degrades to one strike, and a single cheap-model misjudgment could archive a real note)
- [x] Prompt-injection reject filter at the memory boundary, and a widened secret scanner: memory pushed into context unasked is a stored-XSS surface, and notes are git-committed

Open, in rough priority order:

- [ ] **Ground the reward in tool exit status.** Today `r` is read from the transcript's prose, so it resolves on a minority of sessions and Q moves slowly. Pair each `tool_use` with its `tool_result` and key `r` on the runner's own verdict, layered over the current signal rather than replacing it (the grounded signal alone is sparser). Persist the evidence so every Q update is auditable. This is the single largest gap between what the design claims and what the code does.
- [ ] **A real precision gate at session start.** The per-prompt path abstains correctly; the session-start path has no rarity gate at all, and its similarity floor cannot reject the top hit (BM25 is normalized against the best match, so rank 1 always scores 1.0). A first attempt regressed a real repo to zero recall, so this needs to ship behind the eval, not ahead of it.
- [ ] **Retire or fix `adaptiveCut`.** It requires a 50% relative score drop, but the score carries a large similarity-independent floor, so the cliff it looks for cannot occur and it keeps every candidate. It should do something or be deleted; it should not pretend.
- [ ] **A significance test in the improve loop.** It is dry-run by default now, but its accept rule still fires on a margin smaller than the eval's own run-to-run noise.
## Next

- [x] **Package as a Claude Code plugin**: the repo is its own marketplace (`/plugin marketplace add kirti34n/unified-mem` then `/plugin install unified-mem@unified-mem`) bundling the four hooks and the MCP server. Config moved to `~/.unified-mem/` so it survives the ephemeral plugin install dir.
- [ ] **Ship the worker/consolidator as a plugin monitor** so the learning loop needs no separate cron once monitor ergonomics fit (today the plugin covers in-session inject + capture, and `init.mjs` auto-registers a daily Windows scheduled task for reflection + nightly upkeep, but the plugin itself does not yet schedule them).
- [ ] **Multi-harness adapters**: the vault (markdown + SQLite FTS) is already agent-agnostic; only the hook adapters are Claude-specific. Thin adapters for Codex CLI, Gemini CLI, Cursor, and opencode (all of which expose session-end and context-injection hooks) would let one vault follow you across every agent you run. Codex first (largest audience overlap).
- [ ] **Memory management UI**: dashboard endpoints to edit, retire, pin, and restore a note without hand-editing markdown, plus a "blind spots" view over the gap log. Also the review surface the team feature needs.
- [ ] **Episodic layer**: a searchable three-line summary per session (pull-only, never auto-injected), so "what did we do in this repo last week" is answerable.

## Deferred

- [ ] Team sharing via git pull requests: deferred until a second machine or contributor exists. Recipe is research-validated and ready: one-note-per-file (already true), PR review gates for promoted notes, machine-local Q-scores in a sidecar so shared files stay merge-clean
- [ ] Utilization calibration: deferred. Citation telemetry plus a nightly sampled leave-one-out ablation through the existing harness (the accepted causal measure of whether injected notes changed behavior)
- [ ] Hybrid retrieval (BM25 + local embeddings): deliberately off by default. Measured evidence says BM25 wins on technical vocabulary at this corpus size and top-k redundancy is near zero with atomic deduped notes. When the logged retrieval misses (`gaps.jsonl`) accumulate, add optional local embeddings (transformers.js, no API key, brute-force cosine in the existing SQLite, no native dependency), RRF-fuse with BM25, and A/B it through the harness. Ship only if it wins above noise; if it does not, publish that.

## Non-goals

Hosted sync, a vector-database dependency, real-time team sync, and Mem0-style indiscriminate auto-extraction are out of scope: they would forfeit the local-first, zero-dependency, you-own-the-vault design. The schema gate, abstention default, decay, and budget cap are the anti-noise moat.

