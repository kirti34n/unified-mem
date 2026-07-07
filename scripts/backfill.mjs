// Backfill: enqueue past Claude Code session transcripts (~/.claude/projects/*)
// through the normal worker pipeline, so prior repo history becomes vault notes.
// Usage: node scripts/backfill.mjs [--per-repo N]   then: node scripts/worker.mjs
import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ROOT } from './vault.mjs';

const PER_REPO = Number(process.argv.includes('--per-repo') ? process.argv[process.argv.indexOf('--per-repo') + 1] : 2);
const PROJECTS = join(homedir(), '.claude', 'projects');
mkdirSync(join(ROOT, 'queue'), { recursive: true });

// cwd is recorded inside the transcript itself — more reliable than un-munging the dir name
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
      .slice(0, PER_REPO);
  } catch { continue; }
  for (const { f } of files) {
    const cwd = cwdOf(f);
    if (!cwd) continue;
    if (resolve(cwd) === resolve(ROOT)) continue; // the vault repo itself: already captured live
    const id = `backfill-${basename(cwd)}-${basename(f, '.jsonl').slice(0, 8)}`;
    writeFileSync(join(ROOT, 'queue', `${id}.json`), JSON.stringify({
      session_id: id, transcript_path: f, cwd, ts: new Date().toISOString(), backfill: true,
    }, null, 2));
    console.log(`queued ${id}  (${(statSync(f).size / 1048576).toFixed(1)}MB, cwd: ${cwd})`);
    queued++;
  }
}
console.log(`\n${queued} transcripts queued — now run: node scripts/worker.mjs`);
