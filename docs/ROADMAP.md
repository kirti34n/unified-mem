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
## Next

- [ ] **Package as a Claude Code plugin**: bundle the three hooks and the MCP server into a plugin manifest so install is two slash commands (`/plugin marketplace add` then `/plugin install`) instead of hand-editing `settings.json`. The repo doubles as its own marketplace. This is the single biggest reduction in install friction.
- [ ] **Multi-harness adapters**: the vault (markdown + SQLite FTS) is already agent-agnostic; only the hook adapters are Claude-specific. Thin adapters for Codex CLI, Gemini CLI, Cursor, and opencode (all of which expose session-end and context-injection hooks) would let one vault follow you across every agent you run. Codex first (largest audience overlap).
- [ ] **Memory management UI**: dashboard endpoints to edit, retire, pin, and restore a note without hand-editing markdown, plus a "blind spots" view over the gap log. Also the review surface the team feature needs.
- [ ] **Episodic layer**: a searchable three-line summary per session (pull-only, never auto-injected), so "what did we do in this repo last week" is answerable.

## Deferred

- [ ] Team sharing via git pull requests: deferred until a second machine or contributor exists. Recipe is research-validated and ready: one-note-per-file (already true), PR review gates for promoted notes, machine-local Q-scores in a sidecar so shared files stay merge-clean
- [ ] Utilization calibration: deferred. Citation telemetry plus a nightly sampled leave-one-out ablation through the existing harness (the accepted causal measure of whether injected notes changed behavior)
- [ ] Hybrid retrieval (BM25 + local embeddings): deliberately off by default. Measured evidence says BM25 wins on technical vocabulary at this corpus size and top-k redundancy is near zero with atomic deduped notes. When the logged retrieval misses (`gaps.jsonl`) accumulate, add optional local embeddings (transformers.js, no API key, brute-force cosine in the existing SQLite, no native dependency), RRF-fuse with BM25, and A/B it through the harness. Ship only if it wins above noise; if it does not, publish that.

## Non-goals

Hosted sync, a vector-database dependency, real-time team sync, and Mem0-style indiscriminate auto-extraction are out of scope: they would forfeit the local-first, zero-dependency, you-own-the-vault design. The schema gate, abstention default, decay, and budget cap are the anti-noise moat.

