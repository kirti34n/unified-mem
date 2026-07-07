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

That is by design: memory must never block a session, so hook errors are swallowed. Set `UNIFIED_MEM_DEBUG=1` and the catch blocks append `{ts, script, err}` (where `err` holds the stack) to `<vault>/index/hook-errors.jsonl`. Run the retriever manually (above) to surface errors interactively.

## The worker writes no notes

Usually correct behavior. Routine sessions contain nothing durable, and the reflector is told "fewer is better; zero is valid." It also drops notes matching secret patterns, rejects anything failing the schema gate, skips near-duplicates, and skips tiny transcripts entirely. Check that `queue/` is being drained and read the worker's stdout.

## Does my code or transcript data leave my machine?

Only through the channel you already use: headless `claude -p` calls (reflection, verification, judging, eval) go to the same API as your normal Claude Code sessions. Notes never leave the vault directory, the dashboard binds to localhost only, and there is no telemetry.

## What does this cost to run?

See the cost model in [MECHANISMS.md](MECHANISMS.md#cost-model). Short version: one reflection plus one small judge call per session with a determinate outcome, a handful of haiku calls per night, a hard `daily_budget_usd` cap with a local cost ledger, and `contribution_judge: "heuristic"` for zero judge calls.

## Will the vault fill up with junk?

That is what the forgetting machinery is for: reflector selectivity on the way in, decay and archival on the way out, a per-repo active cap, and dedupe flagging in between. Watch the vault-size trend on the Metrics view: plateau is healthy, linear growth means something is off.

## Can a weird session poison the vault?

Defenses in order: the headless reflector and judge run with all tools denied and a neutral working directory, so a prompt-injected transcript cannot make them read repo files or run anything; transcripts are wrapped as data in the reflector prompt; reflector output passes a schema gate (valid id format, title, body, allowed type) and is rejected outright if it carries a duplicated frontmatter key (the trick that would otherwise dodge the neutral-Q forcing); every note is stamped with provenance by the worker itself, never trusted from LLM output (author, machine, source session, trust class, the consensus defense in the memory-poisoning literature); the reflector is instructed to write in factual voice rather than imperatives (a prompt-level defense, not an enforced gate); secrets are regex-blocked; new notes start at neutral Q and must earn influence through verified outcomes; injections tell Claude to verify against current code; and everything is a git-tracked markdown file you can diff, revert, or delete. Treat the vault like code: review what lands in it, especially before sharing a vault with a team.

## Scheduling the worker and the nightly job

The worker (reflection + scoring) and the consolidator (the nightly "dream" job) are the only pieces that need a schedule. On macOS or Linux, two cron lines:

```
0 * * * * node /path/to/unified-mem/scripts/worker.mjs        # hourly: drain the queue
0 3 * * * node /path/to/unified-mem/scripts/consolidate.mjs   # nightly at 03:00: decay, verify, dedupe
```

Alternatively, run `node scripts/worker.mjs --watch` in a terminal or a process manager to poll the queue every 60s instead of using cron for the worker.

## Where does the dashboard run, and how do I change the port?

`node scripts/dashboard.mjs` serves on `http://localhost:7777`. Set the `PORT` environment variable to move it (for example if 7777 is taken):

```bash
PORT=8888 node scripts/dashboard.mjs
```

It binds to `127.0.0.1` only and checks the `Host` header, so it is not reachable from other machines and a web page you visit cannot read the vault through it.

## How do I back up or share my vault?

The vault is its own git repo (created by `init.mjs`), but nothing commits to it automatically. To snapshot or share it, commit and push to a **private** remote:

```bash
cd <your-vault-dir>   # e.g. ~/.unified-mem/vault
git add -A && git commit -m "snapshot"
git remote add origin <your-private-remote> && git push -u origin main
```

Only note files are tracked; the SQLite index, queue, and cost ledger are rebuildable and gitignored. Keep the remote private: notes can hold repo-specific detail.

## Windows notes

Built and tested on Windows 11 (with Git Bash present). Hook commands use forward slashes and quoted absolute paths, which work across platforms. Task Scheduler equivalents of the cron lines above:

```
schtasks /Create /SC HOURLY /TN unified-mem-worker /TR "node C:\path\to\unified-mem\scripts\worker.mjs"
schtasks /Create /SC DAILY /ST 03:00 /TN unified-mem-dream /TR "node C:\path\to\unified-mem\scripts\consolidate.mjs"
```

Run tests with plain `node --test` (auto-discovery): passing the directory as an argument misbehaves on Windows.
