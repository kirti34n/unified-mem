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
- [ ] Team sharing via git pull requests: deferred until a second machine or contributor exists. Recipe is research-validated and ready: one-note-per-file (already true), PR review gates for promoted notes, machine-local Q-scores in a sidecar so shared files stay merge-clean
- [ ] Utilization calibration: deferred. Citation telemetry plus a nightly sampled leave-one-out ablation through the existing harness (the accepted causal measure of whether injected notes changed behavior)
- [ ] Embeddings and MMR: deliberately skipped. Measured evidence says BM25 wins on technical vocabulary at this corpus size and top-k redundancy is near zero with atomic deduped notes. Revisit only if logged retrieval misses accumulate.

