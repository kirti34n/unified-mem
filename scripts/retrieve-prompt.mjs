// UserPromptSubmit hook: just-in-time retrieval. The user's actual prompt is a far
// stronger query than session-start git context, and notes injected adjacent to the
// decision point get used more than ones buried at session start.
// Aggressive floor (prompt_min_sim) + dedupe vs everything already injected this
// session: MOST prompts should inject nothing. Never blocks; any failure exits 0.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { openDb, scoreNotes, tokenize, CONFIG } from './vault.mjs';

try {
  if (process.env.MEMORY_OFF === '1') process.exit(0);
  const hook = JSON.parse(readFileSync(0, 'utf8'));
  const prompt = String(hook.prompt || '');
  if (prompt.length < 25 || prompt.startsWith('/')) process.exit(0); // trivial prompts and commands: nothing to match
  const db = openDb();
  const sessionId = hook.session_id || 'unknown';
  const seen = new Set(db.prepare('SELECT note_id FROM injections WHERE session_id=?')
    .all(sessionId).map(r => r.note_id));
  const terms = tokenize(prompt + ' ' + basename(hook.cwd || ''));
  const k = CONFIG.prompt_k;
  const top = scoreNotes(db, terms, k + seen.size)
    .filter(n => !seen.has(n.id) && n.sim >= CONFIG.prompt_min_sim)
    .slice(0, k);
  if (!top.length) process.exit(0); // the common, correct outcome

  let out = 'Vault notes matching this prompt (cross-repo knowledge; verify against current code):\n';
  for (const n of top) {
    const flag = n.status === 'needs-review' ? ' [NEEDS REVIEW: underlying code changed]' : '';
    out += `\n## ${n.title}${flag}\n(repos: ${n.repos} · files: ${n.files} · commit: ${n.source_commit})\n${n.body}\n`;
  }
  process.stdout.write(out.slice(0, 6000));

  const inj = db.prepare('INSERT INTO injections (session_id,note_id,rank,score,demo) VALUES (?,?,?,?,0)');
  const touch = db.prepare('UPDATE notes SET access_count=access_count+1, last_used=? WHERE id=?');
  const today = new Date().toISOString().slice(0, 10);
  top.forEach((n, i) => { inj.run(sessionId, n.id, 100 + i, n.score); touch.run(today, n.id); }); // rank 100+ = per-prompt injection
} catch { /* memory must never block a prompt */ }
process.exit(0);
