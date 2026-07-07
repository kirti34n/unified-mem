# FAQ and troubleshooting

## Does this replace CLAUDE.md or auto-memory?

No. It sits on top of them. Keep writing instructions in `CLAUDE.md`; keep auto-memory on (it is per-project working memory and ships enabled). unified-mem only takes what transcends a single project: the reflector is explicitly told to skip project-local ephemera the built-in layer already owns. If you disabled auto-memory, unified-mem still works; they are independent.

## Notes are not being injected

Hooks only apply to sessions started after editing settings, so open a fresh session. Test the retriever directly:

```bash
echo '{"session_id":"t","cwd":"/path/to/some/repo"}' | node scripts/retrieve.mjs
```

should print the memory catalog. `MEMORY_OFF=1` in your environment silences everything by design (that is the eval control arm).

## A hook seems broken but nothing errors

That is by design: memory must never block a session, so hook errors are swallowed. Set `UNIFIED_MEM_DEBUG=1` and the catch blocks append `{ts, script, stack}` to `<vault>/index/hook-errors.jsonl`. Run the retriever manually (above) to surface errors interactively.

## The worker writes no notes

Usually correct behavior. Routine sessions contain nothing durable, and the reflector is told "fewer is better; zero is valid." It also drops notes matching secret patterns, rejects anything failing the schema gate, skips near-duplicates, and skips tiny transcripts entirely. Check that `queue/` is being drained and read the worker's stdout.

## Does my code or transcript data leave my machine?

Only through the channel you already use: headless `claude -p` calls (reflection, verification, judging, eval) go to the same API as your normal Claude Code sessions. Notes never leave the vault directory, the dashboard binds to localhost only, and there is no telemetry.

## What does this cost to run?

See the cost model in [MECHANISMS.md](MECHANISMS.md#cost-model). Short version: one reflection plus one small judge call per session with a determinate outcome, a handful of haiku calls per night, a hard `daily_budget_usd` cap with a local cost ledger, and `contribution_judge: "heuristic"` for zero judge calls.

## Will the vault fill up with junk?

That is what the forgetting machinery is for: reflector selectivity on the way in, decay and archival on the way out, a per-repo active cap, and dedupe flagging in between. Watch the vault-size trend on the Metrics view: plateau is healthy, linear growth means something is off.

## Can a weird session poison the vault?

Defenses in order: transcripts are wrapped as data in the reflector prompt; reflector output passes a schema gate (valid id format, title, body, allowed type); every note is stamped with provenance by the worker itself, never trusted from LLM output (author, machine, source session, trust class, the consensus defense in the memory-poisoning literature); notes are written in factual voice, never instructions; secrets are regex-blocked; new notes start at neutral Q and must earn influence through verified outcomes; injections tell Claude to verify against current code; and everything is a git-tracked markdown file you can diff, revert, or delete. Treat the vault like code: review what lands in it, especially before sharing a vault with a team.

## Windows notes

Built and tested on Windows 11 (with Git Bash present). Hook commands use forward slashes and quoted absolute paths, which work across platforms. Task Scheduler equivalents of the cron lines:

```
schtasks /Create /SC HOURLY /TN unified-mem-worker /TR "node C:\path\to\unified-mem\scripts\worker.mjs"
schtasks /Create /SC DAILY /ST 03:00 /TN unified-mem-dream /TR "node C:\path\to\unified-mem\scripts\consolidate.mjs"
```

Run tests with plain `node --test` (auto-discovery): passing the directory as an argument misbehaves on Windows.
