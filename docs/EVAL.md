# Measuring whether memory actually helps

Numbers about memory systems are usually circular: benchmarks graded against the same corpus the answers came from. This harness is built to avoid that, and to be honest about what it can and cannot show.

## Method

```bash
node eval/run.mjs --runs 2        # arm A memory on, arm B MEMORY_OFF=1 control
```

- Same questions through headless `claude -p`, twice: arm A with memory hooks live, arm B with `MEMORY_OFF=1`.
- **Per-question `cwd`**: each question can run inside the repository it is about, so the control arm gets a fair shot at re-deriving the answer from the code and git history. The comparison then measures memory versus re-discovery, not memory versus nothing.
- **Pinned regex grading** (`expect` field per question), never an unpinned LLM judge: judge drift silently makes scores incomparable over time. Grading also rejects hedged non-answers: an "I don't know" that merely happens to contain the keyword is scored as a failure, not a pass (except on negative probes, where "I don't know" is the correct answer).
- **Negative probes**: questions whose correct answer is "I don't know". Include near-miss probes (plausible topics the vault does not actually hold a note on) as well as unrelated ones, since a near-miss is what a memory system actually fails on.
- **Preflight**: if the retriever produces no output while the vault has notes, the run aborts (arm A would silently equal arm B and every number would be a lie).
- **Budget-guarded**: eval calls go through the same daily cost cap and ledger as every other pipeline call, and the run stops rather than overspending.
- Eval sessions read memory but never mutate retrieval state (no last-used ratchets) and are never captured for reflection.
- Results land in `<vault>/eval-results/` as JSON with per-run rows and per-arm medians.

## Real-history result (author's vault)

*Run 2026-07-07 against a 33-note vault (the vault holds 55 notes today), on retrieval and capture code that has since changed (`scripts/retrieve.mjs`, `retrieve-prompt.mjs`, `vault.mjs` and `worker.mjs` were reworked on 2026-07-14). The numbers below are honest but stale: the eval has not been re-run.*

9 questions (6 real incidents, 3 negative probes) across 5 repos, 2 runs, 18 samples per arm, control free to explore the repos, hedged non-answers graded as failures:

| | Memory | Control |
|---|---|---|
| Correct | 15/18 (83%) | 8/18 (44%) |
| Median latency | 12.3s | 11.9s |
| Negative probes (honesty) | 5/6 | 5/6 |

Per-question, control (arm B) correct out of 2 runs: prism-cp1252 2, prism-thinking-empty 1, pai-kill-by-port 0, cct-empty-queue 0, docgen-dollar-swallow 0, umem-busy-timeout 0. Memory (arm A) got all six incidents 2/2 **except** docgen-dollar-swallow, which it also missed 0/2, because the vault holds no note about that bug. That is the honest signature of a real memory system: it helps exactly where it has a relevant note and nowhere else. Three incidents the control failed both attempts (kill-by-port, the hardcoded date filter, the SQLite busy-timeout) memory answered both. Latency is a wash. Both arms scored 5/6 on the honesty probes, so memory did not make the model more likely to confabulate about topics it never learned. One run of a demonstration-scale eval (n=18, single vault, single machine), cost about $0.88 on haiku; treat it as a demonstration of the mechanism, not a field benchmark.

## Limitations, stated plainly

- Small single-vault, single-machine sample. This demonstrates the mechanism end to end; it is not a field benchmark, and below the 15-question floor the harness recommends, individual deltas will jitter run to run.
- Regex grading is strict but shallow: it verifies the load-bearing fact appears (and is not hedged away), not answer quality.
- The bundled `eval/questions.json` is demo data wired to the fictional seed notes; it demonstrates plumbing, not value. When no `eval/questions.real.json` exists the harness falls back to it with a loud warning; pass `--demo` to force it deliberately.
- The memory arm is a retrieval-plus-comprehension check: when the vault holds a note about an incident, injecting it lets a fresh session answer. The load-bearing evidence is the *control* arm's failure rate, which measures how unreliable re-deriving the answer from the code alone is.

## Build your real question set

Create `eval/questions.real.json`; once it exists it becomes the default for both the harness and the improve loop:

```json
[
  {
    "id": "short-slug",
    "cwd": "/path/to/the/repo/it/happened/in",
    "q": "The question, written from a real incident. If you don't know, say so plainly.",
    "expect": "(regex|that matches|the load-bearing fact)"
  }
]
```

Rules that keep it honest: write questions from git history and incident memory, not by reading your vault notes; include at least one negative probe; use 15 or more questions and 2 or more runs before trusting deltas (the improve loop enforces a 14-sample floor and refuses to run below it).
