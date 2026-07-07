# Measuring whether memory actually helps

Numbers about memory systems are usually circular: benchmarks graded against the same corpus the answers came from. This harness is built to avoid that, and to be honest about what it can and cannot show.

## Method

```bash
node eval/run.mjs --runs 2        # arm A memory on, arm B MEMORY_OFF=1 control
```

- Same questions through headless `claude -p`, twice: arm A with memory hooks live, arm B with `MEMORY_OFF=1`.
- **Per-question `cwd`**: each question can run inside the repository it is about, so the control arm gets a fair shot at re-deriving the answer from the code and git history. The comparison then measures memory versus re-discovery, not memory versus nothing.
- **Pinned regex grading** (`expect` field per question), never an unpinned LLM judge: judge drift silently makes scores incomparable over time.
- **Negative probes**: questions whose correct answer is "I don't know" catch a vault that teaches the model to hallucinate confidence.
- **Preflight**: if the retriever produces no output while the vault has notes, the run aborts (arm A would silently equal arm B and every number would be a lie).
- Eval sessions read memory but never mutate retrieval state (no last-used ratchets) and are never captured for reflection.
- Results land in `<vault>/eval-results/` as JSON with per-run rows and per-arm medians.

## First real-history result (author's vault)

7 questions from real incidents across 6 repos, 2 runs, 14 samples per arm, control free to explore the repos:

| | Memory | Control |
|---|---|---|
| Correct | 14/14 (100%) | 8/14 (57%) |
| Median latency | 11.9s | 12.1s |
| Negative probe | passed | passed |

Three incidents were answerable only from memory. One control run spent 104 seconds searching a repo and still failed a question memory answered in 11 seconds.

## Limitations, stated plainly

- Single vault, single machine, n=14 per arm. This demonstrates the mechanism end to end; it is not a field benchmark.
- Regex grading is strict but shallow: it verifies the load-bearing fact appears, not answer quality.
- The bundled `eval/questions.json` is demo data wired to the fictional seed notes; it demonstrates plumbing, not value, and only runs behind an explicit `--demo` flag.

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
