# Contributing

Thanks for looking. unified-mem is a small, zero-dependency codebase, and the goal is to keep it that way.

## Dev setup

You need Node 22.13 or newer (that is where `node:sqlite` unflagged; older versions cannot run the code).

```bash
git clone https://github.com/kirti34n/unified-mem && cd unified-mem
node scripts/init.mjs     # creates a vault (its own git repo, outside this checkout)
node scripts/seed.mjs     # demo history to explore
node --test               # unit tests (must pass)
node scripts/smoke.mjs    # end-to-end smoke in a temp vault (must print SMOKE OK)
node scripts/dashboard.mjs   # http://localhost:7777
```

## Ground rules

- **Zero runtime dependencies, forever.** CI fails the build if `package.json` gains a `dependencies` entry. Use Node builtins and SQLite FTS. Frontend assets (PrismJS) are vendored, not npm deps, and listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- **Every non-trivial change ships a test.** Put pure logic in `scripts/vault.mjs` (it is import-safe) and add a `node:test` case in `test/vault.test.mjs`. Scripts that run work on import cannot be unit-tested, so keep testable logic in the library.
- **Cross-platform.** The code runs on macOS, Linux, and Windows via Claude Code hooks. No hardcoded path separators, use `node:path`; no assumptions about line endings or the home-dir variable.
- **Memory must never block a session.** Hooks swallow their own errors and exit 0. Keep it that way; use `UNIFIED_MEM_DEBUG=1` for diagnostics.
- **No em or en dashes** in generated text, docs, or comments (project style).

## Before opening a PR

Run `node --test` and `node scripts/smoke.mjs`; both must be green. If you touched retrieval, scoring, or consolidation, describe the behavior change and, where it makes sense, show an A/B result from `node eval/run.mjs`.

## Design context

Read [docs/MECHANISMS.md](docs/MECHANISMS.md) (as-built), [docs/CONFIG.md](docs/CONFIG.md) (every knob), and [docs/ROADMAP.md](docs/ROADMAP.md) (what is planned, deferred, and out of scope) before proposing larger changes. The non-goals in the roadmap are deliberate; please do not reopen them without new evidence.
