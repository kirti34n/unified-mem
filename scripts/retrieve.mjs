// SessionStart hook: print top-k vault notes (stdout → injected context)
// and log the injection. Never blocks a session: any failure exits 0 silently.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { openDb, scoreNotes, tokenize, CONFIG } from './vault.mjs';

const MAX_CHARS = CONFIG.max_inject_chars; // ≈2,500 tokens (PLAN §4.2)

try {
  if (process.env.MEMORY_OFF === '1') process.exit(0); // eval control arm

  let hook = {};
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch {}
  const cwd = hook.cwd || process.argv[2] || process.cwd();
  const sessionId = hook.session_id || `manual-${Date.now()}`;

  const git = cmd => { try { return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return ''; } };
  const query = tokenize([
    basename(cwd),
    git('git branch --show-current'),
    git('git log -5 --format=%s'),
    git('git diff --name-only HEAD~5 2>NUL') || git('git diff --name-only'),
  ].join(' '));

  const db = openDb();
  const top = scoreNotes(db, query);
  if (!top.length) process.exit(0);

  let out = 'Team knowledge notes from past sessions (verify against current code before relying on them):\n';
  const used = [];
  for (const n of top) {
    const flag = n.status === 'needs-review' ? ' [NEEDS REVIEW — the underlying code changed; verify before use]' : '';
    const block = `\n## ${n.title}${flag}\n(type: ${n.type} · repos: ${n.repos} · files: ${n.files} · commit: ${n.source_commit})\n${n.body}\n`;
    if (out.length + block.length > MAX_CHARS) break;
    out += block;
    used.push(n);
  }
  process.stdout.write(out);

  const ts = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO sessions (id,ts,repo,outcome,tokens_injected,summary,demo) VALUES (?,?,?,?,?,?,0)')
    .run(sessionId, ts, basename(cwd), 'indeterminate', Math.round(out.length / 4), hook.source || 'startup');
  const inj = db.prepare('INSERT INTO injections (session_id,note_id,rank,score,demo) VALUES (?,?,?,?,0)');
  const touch = db.prepare('UPDATE notes SET access_count=access_count+1, last_used=? WHERE id=?');
  used.forEach((n, i) => { inj.run(sessionId, n.id, i + 1, n.score); touch.run(ts.slice(0, 10), n.id); });
} catch { /* memory must never block a session */ }
process.exit(0);
