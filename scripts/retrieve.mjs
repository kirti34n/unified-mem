// SessionStart hook: print top-k vault notes (stdout → injected context)
// and log the injection. Never blocks a session: any failure exits 0 silently.
// Also auto-registers the repo: any git repo you open a session in joins the
// repos map (enabling staleness watching + a repo card) unless disabled in the
// dashboard's Repos view.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { openDb, scoreNotes, tokenize, hookDebugLog, loadConfig, CONFIG, ROOT, VAULT } from './vault.mjs';

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
    git('git diff --name-only HEAD~5') || git('git diff --name-only'),
  ].join(' '));

  const repoName = basename(cwd);
  if ((CONFIG.disabled_repos || []).includes(repoName)) process.exit(0); // memory switched off for this repo (dashboard Repos view)

  // AUTO-REGISTER: a real session in a git repo not yet in the repos map adds it,
  // so every new or old repo is covered the first time you open a session there.
  // An instant minimal card gives this session repo awareness; the nightly job
  // enriches it with vault knowledge.
  if (process.env.UNIFIED_MEM_NO_CAPTURE !== '1' && !CONFIG.repos?.[repoName] && existsSync(join(cwd, '.git'))) {
    try {
      const cfgPath = join(ROOT, 'config.json');
      const c = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
      c.repos = { ...(c.repos || {}), [repoName]: cwd.replace(/\\/g, '/') };
      writeFileSync(cfgPath, JSON.stringify(c, null, 2) + '\n');
    } catch { /* concurrent session may have won the write; harmless */ }
    try {
      const cardPath = join(VAULT, 'repos', `${repoName}.md`);
      if (!existsSync(cardPath)) {
        mkdirSync(join(VAULT, 'repos'), { recursive: true });
        const g = cmd => { try { return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
        const recent = g('git log -5 --format=%cs %s').split('\n').filter(Boolean).map(l => `- ${l}`).join('\n');
        writeFileSync(cardPath, `# ${repoName}\n\n(auto-registered; the nightly job enriches this card)\n\n- path: ${cwd.replace(/\\/g, '/')}\n- branch: ${g('git branch --show-current') || '?'}\n${recent ? `\n**Recent activity:**\n${recent}\n` : ''}`);
      }
    } catch { }
  }

  const db = openDb();

  // Dedupe vs notes already injected this session: resume/compact re-fires this
  // hook, and duplicate injection rows would double a note's per-session Q updates.
  const seen = new Set(db.prepare('SELECT note_id FROM injections WHERE session_id=?')
    .all(sessionId).map(r => r.note_id));

  const perRepo = {};
  for (const row of db.prepare("SELECT repos FROM notes WHERE status != 'archived'").all())
    for (const r of (row.repos || '').split(',').map(s => s.trim()).filter(Boolean))
      perRepo[r] = (perRepo[r] || 0) + 1;
  const anyNotes = db.prepare("SELECT COUNT(*) c FROM notes WHERE status != 'archived'").get().c;
  if (!anyNotes) process.exit(0); // empty vault: inject nothing

  const used = [];
  let out = 'Unified cross-repo memory (a layer on top of this project\'s own memory). This is the cold-start catalog; matching notes auto-load with each prompt, vault_search pulls explicitly, and vault_remember saves a personal preference. Verify anything against current code.\n';

  // PERSONAL PREFERENCES: pinned, no similarity floor. Preferences apply in every
  // repo by definition; they are explicit user statements, not retrieved guesses.
  // Trust gate: only user-explicit notes may pin. A file written into notes/ by
  // anything else (including demo seed data) never reaches every session.
  const prefs = db.prepare("SELECT * FROM notes WHERE type='preference' AND status='active' AND trust='user-explicit' ORDER BY q_value DESC, created DESC").all()
    .filter(n => !seen.has(n.id));
  let pinned = '';
  const pinnedNotes = [];
  for (const p of prefs) {
    const line = `- ${p.body.replace(/\s+/g, ' ').trim()}\n`;
    if (pinned.length + line.length > (CONFIG.personal_budget_chars ?? 800)) break;
    pinned += line;
    pinnedNotes.push(p);
  }
  if (pinned) out += `\nPERSONAL PREFERENCES (apply in every repo):\n${pinned}`;
  used.push(...pinnedNotes);

  // COLD START = a compact CATALOG of what the unified memory holds, plus this
  // repo's overview card. Details load on demand, never five speculative notes.
  if (Object.keys(perRepo).length)
    out += `\nMEMORY CATALOG (notes per repo): ${Object.entries(perRepo).sort((a, b) => b[1] - a[1]).map(([r, c]) => `${r} (${c})`).join(' · ')}\n`;
  try {
    const card = readFileSync(join(VAULT, 'repos', `${repoName}.md`), 'utf8');
    out += `\nTHIS REPO, what is there and what is happening:\n${card.replace(/^# .*\r?\n/, '').trim().slice(0, 1400)}\n`;
  } catch { /* no card yet for this repo */ }

  // Relevance floor: injecting nothing beats injecting noise. A note must be
  // meaningfully relevant (sim >= start_min_sim, one shared token is not enough)
  // or have PROVEN high utility (q>=0.7) to ride along with the catalog.
  // demo-seeded notes never ride the utility bypass into real sessions
  const top = scoreNotes(db, query)
    .filter(n => (n.sim >= CONFIG.start_min_sim || (n.q_value >= 0.7 && n.trust !== 'demo')) && !seen.has(n.id) && n.type !== 'preference');
  if (top.length) out += '\nMost relevant notes for this repo right now:\n';
  for (const n of top) {
    const flag = n.status === 'needs-review' ? ' [NEEDS REVIEW, the underlying code changed; verify before use]' : '';
    const block = `\n## ${n.title}${flag}\n(type: ${n.type} · repos: ${n.repos} · files: ${n.files} · commit: ${n.source_commit})\n${n.body}\n`;
    if (out.length + block.length > MAX_CHARS) break;
    out += block;
    used.push(n);
  }
  process.stdout.write(out);

  // Eval sessions read memory but must not mutate retrieval state (last_used /
  // access_count ratchets would self-reinforce the notes the eval targets).
  if (process.env.UNIFIED_MEM_NO_CAPTURE === '1') process.exit(0);
  const ts = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO sessions (id,ts,repo,outcome,tokens_injected,summary,demo) VALUES (?,?,?,?,?,?,0)')
    .run(sessionId, ts, basename(cwd), 'indeterminate', Math.round(out.length / 4), hook.source || 'startup');
  const inj = db.prepare('INSERT INTO injections (session_id,note_id,rank,score,demo) VALUES (?,?,?,?,0)');
  const touch = db.prepare('UPDATE notes SET access_count=access_count+1, last_used=? WHERE id=?');
  // pinned preferences come from a plain SELECT and carry no score; node:sqlite
  // rejects undefined binds, and one bad bind would kill logging for the session
  used.forEach((n, i) => { inj.run(sessionId, n.id, i + 1, n.score ?? n.q_value ?? 0); touch.run(ts.slice(0, 10), n.id); });
} catch (e) { hookDebugLog('retrieve', e); /* memory must never block a session */ }
process.exit(0);
