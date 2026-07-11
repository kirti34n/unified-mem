// Starter vault: a small, curated set of GENUINELY useful, broadly-applicable coding
// gotchas so a fresh install is not cold-empty (Memento ships its case bank for the
// same reason). Unlike seed.mjs (fictional demo data, trust:demo, excluded from real
// sessions), these are real knowledge: trust:seed, so they ARE retrieved and injected,
// but never pin (not user-explicit) and start at q 0.40 so an unused starter note
// decays and retires on its own as the user's own organic notes accumulate.
//   node scripts/starter.mjs [--force]   install (refuses a vault that already has starters unless --force)
//   node scripts/starter.mjs --remove    delete every starter note
import { writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, reindexNotes, NOTES_DIR } from './vault.mjs';

// [slug, type, polarity, title, entities(csv), triggers(semi-joined), body]
const NOTES = [
  ['windows-console-unicode-crash', 'recovery', 'pitfall',
    'Printing unicode to a legacy Windows console crashes with a cp1252 encode error',
    'windows, unicode, encoding',
    'when a script crashes with UnicodeEncodeError on Windows; when emoji or box-drawing chars break only on Windows',
    '**Problem:** print() of non-ASCII (emoji, arrows, box-drawing) throws UnicodeEncodeError: charmap codec on a legacy Windows console (cp1252). **Fix:** do NOT emit non-ASCII to a console you do not control; set PYTHONUTF8=1 or reconfigure stdout to utf-8 (sys.stdout.reconfigure(encoding="utf-8")) at startup, or keep output ASCII-only. **Gotchas:** it passes on Mac/Linux and in redirected pipes, so it only surfaces on a real Windows terminal.'],
  ['sqlite-busy-timeout-per-connection', 'recovery', 'guidance',
    'Concurrent SQLite writers need PRAGMA busy_timeout set on EVERY connection',
    'sqlite, concurrency',
    'when SQLite throws SQLITE_BUSY or database is locked under concurrent access; when a second writer fails instead of waiting',
    '**Problem:** a second connection writing the same SQLite db fails immediately with SQLITE_BUSY instead of waiting. **Fix:** run PRAGMA journal_mode=WAL once (persists on the file) AND PRAGMA busy_timeout=5000 on EVERY connection that opens the db. **Gotchas:** busy_timeout is per-connection, not database-wide, so setting it in one place does not cover workers that open their own connections.'],
  ['kill-server-by-port-not-name', 'strategy', 'guidance',
    'On Windows, kill a stuck dev server by its listening PORT, not by process name',
    'windows, process',
    'when a dev server will not die; when a port is still in use after stopping a server; when taskkill by name misses the process',
    '**Approach:** 1. find the PID holding the port with `netstat -ano | findstr :PORT`. 2. `taskkill /F /PID <pid>`. **Why:** killing by image name (node.exe) can miss the right instance or kill unrelated ones; the port uniquely identifies the stuck listener. **Gotchas:** proc.terminate()/taskkill without /F on Windows does not kill child processes, so a server that spawned workers needs a process-tree kill (psutil children recursive).'],
  ['node-sqlite-no-fts5', 'decision', 'guidance',
    'node:sqlite may ship without the FTS5 module, plan a keyword fallback',
    'node-sqlite, fts5',
    'when CREATE VIRTUAL TABLE USING fts5 throws no such module fts5; when full-text search works on one Node build but not another',
    '**Decision:** do not assume FTS5 is present in node:sqlite. **Steps:** 1. probe once at startup by creating a throwaway fts5 table in :memory: inside try/catch. 2. if it throws, fall back to a keyword-overlap scorer over the same fields. **Gotchas:** the FTS5 module was compiled into node:sqlite only from a later build; the version where node:sqlite unflagged ships without it, so pin-floor installs miss it.'],
  ['bash-heredoc-mangles-regex', 'recovery', 'pitfall',
    'Bash heredocs on Windows Git Bash silently strip backslashes from regex literals',
    'bash, regex, windows',
    'when a generated script has a syntax error in a regex; when a backslash disappears from code written via a heredoc',
    '**Problem:** piping code that contains a regex literal (e.g. .replace(/\\//g, "/")) through a bash heredoc drops backslashes before the file is written, producing a valid-looking file that fails only at runtime. **Fix:** do not author code with regex escapes via heredocs on this platform; write the exact bytes with an editor/Write tool, or avoid the regex. **Gotchas:** the corruption is at write time and silent, so a syntax check that reads the file still fails to reveal the intent; run the script to confirm.'],
  ['test-cleanup-fk-order', 'convention', 'guidance',
    'Delete child rows before parent rows in test teardown or FK constraints fail',
    'sqlite, testing, foreign-key',
    'when test teardown fails with a foreign key constraint error; when tearing down seeded relational fixtures',
    '**Convention:** when foreign keys are enforced, teardown must delete in reverse dependency order (children first, then parents), the mirror of insertion order. **Gotchas:** the tests pass individually but fail when run together or in a shared-db suite, because leftover parent rows collide; enabling FK enforcement in tests (it is often off by default) surfaces the ordering bug early.'],
  ['thinking-model-empty-output', 'recovery', 'pitfall',
    'Thinking models can return empty output when reasoning exhausts the token budget',
    'llm, thinking-model',
    'when a local reasoning model returns an empty answer after a long delay; when a model spends its whole budget in a think block',
    '**Problem:** a thinking model (qwen3+, deepseek-r1, qwq) returns an empty final answer after a long call because it spent its entire token budget inside a <think> block and was cut off before the answer. **Fix:** disable thinking for these families (e.g. Ollama think:false) or raise the token budget substantially; inflating the budget alone is unreliable. **Gotchas:** the call succeeds (no error), it just yields empty content after the incomplete think tag is stripped.'],
  ['small-llm-placeholder-content', 'recovery', 'pitfall',
    'Small local LLMs silently emit placeholder content across multi-call structured pipelines',
    'llm, structured-output',
    'when a generated document has generic placeholder text on every section; when a multi-step LLM pipeline produces schema-valid but empty content',
    '**Problem:** a small local model handles one structured-output call fine but degrades to schema-valid boilerplate ("Welcome to Our Deck") across the many strict per-item calls a full document needs, with no error since placeholder text still validates. **Fix:** use a stronger/hosted model for multi-call structured generation; validation schemas alone cannot catch this. **Gotchas:** a single-call demo looks perfect, so the failure only appears at full document scale.'],
  ['script-cwd-import-path', 'recovery', 'pitfall',
    'Scripts run from a temp/scratch dir need the repo root on the path or internal imports fail',
    'python, imports',
    'when a helper script throws ModuleNotFoundError for a local package; when a script works from the repo root but not elsewhere',
    '**Problem:** a script executed from a temp/scratch directory outside the repo cannot import the repo internal packages because the repo root is not on the module path. **Fix:** run helper scripts with the repo root on sys.path (or invoke via `python -m` / cwd=<repo root>), not from the scratch location. **Gotchas:** distinct from a relative-path issue in the script itself; the code is correct, the execution context is wrong.'],
  ['windows-path-separator-compare', 'convention', 'pitfall',
    'Normalize path separators before comparing paths, Windows mixes / and backslash',
    'windows, path',
    'when a path equality or includes check fails only on Windows; when a substring path match misses due to backslashes',
    '**Convention:** before comparing or substring-matching paths, normalize separators (replace backslash with forward slash) on both sides. **Gotchas:** Windows APIs and user input mix `/` and `\\` freely, so a raw string compare of two paths that point at the same location can be false; this bites path-membership checks (is X under Y) most often.'],
];

const db = openDb();
const dir = join(NOTES_DIR, 'starter');
const today = new Date().toISOString().slice(0, 10);
const idOf = slug => `${today}-starter-${slug}`;

if (process.argv.includes('--remove')) {
  let removed = 0;
  for (const row of db.prepare("SELECT id, path FROM notes WHERE trust='seed'").all()) {
    try { if (row.path && existsSync(row.path)) { unlinkSync(row.path); removed++; } } catch { }
    db.prepare('DELETE FROM notes WHERE id=?').run(row.id);
  }
  reindexNotes(db);
  console.log(`starter removed: ${removed} note files deleted`);
  process.exit(0);
}

const existing = db.prepare("SELECT id, path FROM notes WHERE trust='seed'").all();
if (existing.length && !process.argv.includes('--force')) {
  console.error(`refusing: vault already has ${existing.length} starter note(s). Pass --force to reinstall, or --remove to clear them.`);
  process.exit(1);
}
// --force reinstall: delete existing seed notes FIRST so a reinstall is clean regardless
// of date. Ids are date-stamped (TODAY-starter-slug), so without this a cross-day --force
// would leave yesterday's files on disk and accumulate date-stamped duplicates of each note.
for (const row of existing) {
  try { if (row.path && existsSync(row.path)) unlinkSync(row.path); } catch { }
  db.prepare('DELETE FROM notes WHERE id=?').run(row.id);
}

mkdirSync(dir, { recursive: true });
let written = 0;
for (const [slug, type, polarity, title, entities, triggers, body] of NOTES) {
  const id = idOf(slug);
  const note = `---
id: ${id}
type: ${type}
title: ${title}
entities: [${entities}]
triggers: ${triggers}
polarity: ${polarity}
repos: []
files: []
source_commit: seed
confidence: high
q_value: 0.40
access_count: 0
last_used: null
last_validated: ${today}
status: active
scope: shared
trust: seed
links: []
---
${body}
`;
  writeFileSync(join(dir, `${id}.md`), note);
  written++;
}
const indexed = reindexNotes(db);
console.log(`starter installed: ${written} generic pitfall/guidance notes written, ${indexed} total notes indexed`);
