// Backfill: enqueue past Claude Code session transcripts (~/.claude/projects/*)
// through the normal worker pipeline, so prior repo history becomes vault notes.
// Usage: node scripts/backfill.mjs [--per-repo N]   then: node scripts/worker.mjs
import { readdirSync, readFileSync, writeFileSync, renameSync, statSync, mkdirSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { openDb, VAULT, ROOT } from './vault.mjs';

// A bare `--per-repo` with the value forgotten, or a non-numeric one, used to yield NaN. That was
// harmless only because the budget was applied as .slice(0, NaN), which takes nothing. The budget is
// now a counter in the loop below (it has to be: it must be spent AFTER the skips, not before), and
// `taken >= NaN` is false forever, so an unsanitized NaN would remove the cap entirely and queue
// every transcript on disk, each one billed to a reflect call. Sanitize it here, once.
const perRepoArg = Number(process.argv.includes('--per-repo') ? process.argv[process.argv.indexOf('--per-repo') + 1] : 2);
const PER_REPO = Number.isFinite(perRepoArg) && perRepoArg >= 0 ? perRepoArg : 2;
const PROJECTS = join(homedir(), '.claude', 'projects');
mkdirSync(join(VAULT, 'queue'), { recursive: true });
const db = openDb(); // read-only here: used to skip transcripts this vault has already ingested

// HEADLESS TRANSCRIPTS ARE NOT SESSIONS. Every pipeline call (reflect, judge, arbiter, verify)
// shells out to `claude -p`, and Claude Code writes each one its own transcript into
// ~/.claude/projects, indistinguishable by filename from a human session (108 of the 322 transcripts
// on the author's machine are ours). enqueue.mjs is safe because it runs INSIDE that child and sees
// runClaude's MEMORY_OFF=1; backfill reads the same files off disk hours later, when the env var is
// long gone, so `cwd === ROOT` was its only guard. That covers reflect, judge and arbiter (all pass
// cwd: ROOT) but NOT verify, which MUST run with cwd: repoPath to read the repo's own code
// (consolidate.mjs), so its transcript lands in a FOREIGN repo's project dir carrying that repo's
// cwd and sails through. And a verify prompt EMBEDS THE FULL TEXT OF A VAULT NOTE, so reflecting on
// one re-distills an existing note back into a new note and bills a sonnet call to do it.
// `entrypoint` is Claude Code's own field and the only durable on-disk marker: 'cli' is an
// interactive session, 'sdk-cli' is any headless -p call. Fail CLOSED on a missing value: backfilling
// nothing is a recoverable no-op, backfilling our own machinery is not.
function entrypointOf(path) {
  for (const line of readFileSync(path, 'utf8').split('\n').slice(0, 50)) {
    try { const j = JSON.parse(line); if (j.entrypoint) return j.entrypoint; } catch { }
  }
  return null;
}

// cwd is recorded inside the transcript itself, more reliable than un-munging the dir name
function cwdOf(path) {
  for (const line of readFileSync(path, 'utf8').split('\n').slice(0, 50)) {
    try { const j = JSON.parse(line); if (j.cwd) return j.cwd; } catch { }
  }
  return null;
}

let queued = 0;
for (const dir of readdirSync(PROJECTS)) {
  const full = join(PROJECTS, dir);
  let files;
  try {
    files = readdirSync(full).filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f: join(full, f), st: statSync(join(full, f)) }))
      .filter(x => x.st.size > 50_000) // skip trivial sessions
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
      .slice(); // NOT the budget. PER_REPO is spent in the loop below, AFTER the skips.
  } catch { continue; }
  // The budget is charged HERE, after the skips, never in the sort above. A pre-skip slice hands a
  // repo's whole budget to transcripts the loop then discards, so the repo backfills NOTHING and
  // says so silently: on the author's machine both slots for docloom, docloom-studio and prism were
  // held by our own headless verify transcripts, while their real sessions sat one row further down
  // the sorted list. Same slice-before-filter shape as retrieve.mjs, same consequence.
  let taken = 0;
  for (const { f } of files) {
    if (taken >= PER_REPO) break;
    const cwd = cwdOf(f);
    if (!cwd) continue;
    if (resolve(cwd) === resolve(ROOT)) continue; // the vault repo itself: already captured live
    if (entrypointOf(f) !== 'cli') continue;      // our own (or another tool's) headless `claude -p` call, not a session
    const id = `backfill-${basename(cwd)}-${basename(f, '.jsonl').slice(0, 8)}`;
    // Already ingested? backfill never consulted the sessions table, so a second run re-queued the
    // same transcripts and paid a fresh reflect call over a multi-MB file to write a note the vault
    // already holds. Checked AFTER the skips and BEFORE the budget is charged, so a repo whose
    // newest session is already in the vault backfills its NEXT-newest one instead of nothing.
    if (db.prepare('SELECT 1 FROM sessions WHERE id=?').get(id)) continue;
    taken++;
    // atomic: write a temp file then rename, so the worker never reads a half-written entry
    const dest = join(VAULT, 'queue', `${id}.json`);
    const tmp = dest + '.tmp';
    writeFileSync(tmp, JSON.stringify({
      session_id: id, transcript_path: f, cwd, ts: new Date().toISOString(), backfill: true,
    }, null, 2));
    renameSync(tmp, dest);
    console.log(`queued ${id}  (${(statSync(f).size / 1048576).toFixed(1)}MB, cwd: ${cwd})`);
    queued++;
  }
}
console.log(`\n${queued} transcripts queued, now run: node scripts/worker.mjs`);
