// Nightly consolidation "dream" job (R6/R7/R9). Incremental ops only:
//   INVALIDATE  active notes whose files changed since last_validated → needs-review
//   DECAY       Q ← Q·factor^weeks on notes unused past threshold
//   ARCHIVE     Q < floor AND long-unused → archived
//   DEDUPE      flag near-duplicate pairs for review (LLM merge is Phase 3+)
//   METRICS     upsert today's metrics_daily row + enforce active cap report
// Every content change writes a consolidations row with the exact diff (dashboard renders it).
import { spawnSync } from 'node:child_process';
import { openDb, reindexNotes, updateNoteFile, CONFIG } from './vault.mjs';

const db = openDb();
reindexNotes(db);
const now = new Date();
const ts = now.toISOString();
const today = ts.slice(0, 10);
const days = d => d ? (now - new Date(d)) / 86400000 : Infinity;
const log = db.prepare('INSERT INTO consolidations (ts,op,note_id,detail,diff,demo) VALUES (?,?,?,?,?,0)');
const counts = { invalidate: 0, decay: 0, archive: 0, dedupe: 0 };

const notes = db.prepare('SELECT * FROM notes').all();

// INVALIDATE — the single biggest accuracy lever (PLAN §4.3)
for (const n of notes.filter(n => n.status === 'active' && n.files)) {
  const changed = [];
  for (const repo of (n.repos || '').split(',').filter(Boolean)) {
    const repoPath = CONFIG.repos[repo.trim()];
    if (!repoPath) continue; // repo not on this machine — skip gracefully
    for (const file of n.files.split(',').filter(Boolean)) {
      const r = spawnSync('git', ['log', '--oneline', `--since=${n.last_validated || n.created}`, '--', file.trim()],
        { cwd: repoPath, encoding: 'utf8' });
      const out = (r.stdout || '').trim();
      if (out) changed.push(`${repo}/${file.trim()}:\n${out.split('\n').slice(0, 5).join('\n')}`);
    }
  }
  if (changed.length) {
    const diff = updateNoteFile(db, n.id, { status: 'needs-review' });
    log.run(ts, 'invalidate', n.id,
      `Files changed since last_validated (${n.last_validated}) → needs-review. Commits:\n${changed.join('\n')}`, diff);
    counts.invalidate++;
  }
}

// DECAY + ARCHIVE (R7)
for (const n of notes.filter(n => n.status !== 'archived')) {
  const lastEvent = db.prepare('SELECT MAX(ts) t FROM q_history WHERE note_id=?').get(n.id).t;
  const idleDays = Math.min(days(n.last_used), days(lastEvent), days(n.created)); // never-used notes idle from creation
  if (idleDays > CONFIG.archive_unused_days && n.q_value < CONFIG.archive_below_q) {
    const diff = updateNoteFile(db, n.id, { status: 'archived' });
    log.run(ts, 'archive', n.id, `Q ${n.q_value.toFixed(2)} < ${CONFIG.archive_below_q} and unused ${Math.round(idleDays)} days → archived`, diff);
    counts.archive++;
  } else if (idleDays > CONFIG.decay_after_unused_days) {
    const weeks = Math.floor(idleDays / 7);
    const nq = Math.max(CONFIG.q_clamp[0], n.q_value * CONFIG.decay_factor_per_week ** weeks);
    if (n.q_value - nq >= 0.01) {
      db.prepare('INSERT INTO q_history (note_id,session_id,ts,old_q,new_q,contribution,reward,op,demo) VALUES (?,NULL,?,?,?,NULL,NULL,?,0)')
        .run(n.id, ts, n.q_value, nq, 'decay');
      updateNoteFile(db, n.id, { q_value: nq.toFixed(2) });
      log.run(ts, 'decay', n.id, `Unused ${Math.round(idleDays)} days: Q ${n.q_value.toFixed(2)} → ${nq.toFixed(2)} (${CONFIG.decay_factor_per_week}^${weeks})`, null);
      counts.decay++;
    }
  }
}

// DEDUPE candidates — flag, don't auto-merge (context collapse risk, R1)
const seenPair = new Set();
for (const n of notes.filter(n => n.status === 'active')) {
  try {
    const match = n.title.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3).map(w => `"${w}"`).join(' OR ');
    if (!match) continue;
    for (const hit of db.prepare('SELECT id, bm25(notes_fts) r FROM notes_fts WHERE notes_fts MATCH ? AND id != ? ORDER BY r LIMIT 2').all(match, n.id)) {
      if (hit.r > -8) continue; // weak match — not a duplicate candidate
      const pair = [n.id, hit.id].sort().join('|');
      if (seenPair.has(pair)) continue;
      seenPair.add(pair);
      const already = db.prepare("SELECT 1 FROM consolidations WHERE op='dedupe-candidate' AND detail LIKE ?").get(`%${pair}%`);
      if (already) continue;
      log.run(ts, 'dedupe-candidate', n.id, `Possible near-duplicate pair: ${pair} — review and merge manually (keep richest detail)`, null);
      counts.dedupe++;
    }
  } catch { }
}

// METRICS upsert for today + cap report
const cur = db.prepare('SELECT * FROM notes').all();
const active = cur.filter(n => n.status === 'active').length;
const review = cur.filter(n => n.status === 'needs-review').length;
const archived = cur.filter(n => n.status === 'archived').length;
const todayInj = db.prepare("SELECT COUNT(*) c FROM injections i JOIN sessions s ON s.id=i.session_id WHERE s.ts LIKE ?").get(today + '%').c;
const staleInj = db.prepare("SELECT COUNT(*) c FROM injections i JOIN sessions s ON s.id=i.session_id JOIN notes n ON n.id=i.note_id WHERE s.ts LIKE ? AND n.status != 'active'").get(today + '%').c;
db.prepare('INSERT OR REPLACE INTO metrics_daily VALUES (?,?,?,?,?,?,0)').run(today, active, review, archived, staleInj, todayInj);

const perRepo = {};
cur.filter(n => n.status === 'active').forEach(n => (n.repos || '').split(',').forEach(r => perRepo[r] = (perRepo[r] || 0) + 1));
const over = Object.entries(perRepo).filter(([, c]) => c > CONFIG.active_cap_per_repo);
if (over.length) console.warn('OVER CAP:', over.map(([r, c]) => `${r}:${c}`).join(' '));

reindexNotes(db);
console.log(`consolidated: ${counts.invalidate} invalidated · ${counts.decay} decayed · ${counts.archive} archived · ${counts.dedupe} dedupe-candidates · vault ${active}a/${review}r/${archived}x`);
