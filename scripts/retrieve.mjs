// SessionStart hook: print top-k vault notes (stdout → injected context)
// and log the injection. Never blocks a session: any failure exits 0 silently.
// Also auto-registers the repo: any git repo you open a session in joins the
// repos map (enabling staleness watching + a repo card) unless disabled in the
// dashboard's Repos view.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { openDb, scoreNotes, adaptiveCut, resolveSupersessions, tokenize, hookDebugLog, loadConfig, CONFIG, CONFIG_PATH, ROOT, VAULT } from './vault.mjs';

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
      const c = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
      c.repos = { ...(c.repos || {}), [repoName]: cwd.replace(/\\/g, '/') };
      mkdirSync(dirname(CONFIG_PATH), { recursive: true }); // ~/.unified-mem may not exist yet on a fresh plugin install
      writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n');
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

  // trust != 'demo' on BOTH the catalog count and the empty-vault gate: the catalog
  // is injected content, so seeded demo notes (and their fictional repo names like
  // api-core/billing) must not appear in a real session's cold-start context. The
  // dashboard reads the DB directly and still shows demo data; only this injection
  // surface excludes it. A demo-only vault therefore injects nothing, as intended.
  const perRepo = {};
  for (const row of db.prepare("SELECT repos FROM notes WHERE status != 'archived' AND trust != 'demo'").all())
    for (const r of (row.repos || '').split(',').map(s => s.trim()).filter(Boolean))
      perRepo[r] = (perRepo[r] || 0) + 1;
  const anyNotes = db.prepare("SELECT COUNT(*) c FROM notes WHERE status != 'archived' AND trust != 'demo'").get().c;
  if (!anyNotes) process.exit(0); // no real notes: inject nothing (demo-only vault or empty)

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
  if (Object.keys(perRepo).length) {
    const catalog = Object.entries(perRepo).sort((a, b) => b[1] - a[1]).map(([r, c]) => `${r} (${c})`).join(' · ');
    out += `\nMEMORY CATALOG (notes per repo): ${catalog.length > 1200 ? catalog.slice(0, 1200) + '…' : catalog}\n`;
  }
  try {
    const card = readFileSync(join(VAULT, 'repos', `${repoName}.md`), 'utf8');
    out += `\nTHIS REPO, what is there and what is happening:\n${card.replace(/^# .*\r?\n/, '').trim().slice(0, 1400)}\n`;
  } catch { /* no card yet for this repo */ }

  // Similarity floor (start_min_sim) plus a utility bypass (q>=0.7). Read the floor for exactly
  // what it is, because the name oversells it. On the normal path (FTS5 present) ftsSim
  // normalizes BM25 against the BEST hit, so the top-matching note always scores sim = 1.0
  // however weak its absolute match. The floor therefore CANNOT reject rank 1; it only trims the
  // tail below it. Only in the FTS5-missing fallback, where sim is an absolute keyword overlap,
  // can the floor reject rank 1 at all.
  // Measured on the 55-note vault this was written against: a cwd of "some-unknown-repo" (a path
  // that is not a git repo and is named in no note) still injects 5 notes, the full k, with rank 1
  // won on ONE generic shared token. So one shared token IS enough, and session start does NOT
  // abstain on a weak query. The per-prompt path (retrieve-prompt.mjs) is the one with a real
  // precision gate (>=2 rare terms shared with the note); this path has none (see docs/ROADMAP.md).
  // q>=0.7 is not proof of usefulness either: Q is a slow prior nudged by a reward that
  // detectOutcome regex-reads off the transcript tail, and it resolves on roughly 15% of sessions.
  // demo-seeded notes never ride the utility bypass into real sessions
  // trust:demo is excluded from EVERY injection path here, not just the utility
  // bypass: fictional seed content must never ride into a real session via a plain
  // similarity match either, or the catalog reads as real cross-repo knowledge.
  // Split by polarity FIRST so a pitfall gets its own block instead of competing with guidance
  // notes for one list (which would silently drop the whole "do NOT repeat" section).
  // Honesty note: adaptiveCut does NOT trim anything here today. It cuts only on a >=50% relative
  // score drop, but scoreNotes() has already truncated the pool to the top CONFIG.k notes and every
  // note in that pool carries a large similarity-independent floor (q + recency + validity), so no
  // adjacent pair halves (measured on the live vault: 0 cuts across real query groups, largest
  // adjacent drop about 0.42). trim() is therefore an identity function as written (see
  // docs/ROADMAP.md: retire or fix adaptiveCut). The utility bypass (q>=0.7, sim below the floor)
  // is held out of the call regardless, so it always survives.
  const passing = resolveSupersessions(db, scoreNotes(db, query))
    .filter(n => n.trust !== 'demo' && (n.sim >= CONFIG.start_min_sim || n.q_value >= 0.7) && !seen.has(n.id) && n.type !== 'preference');
  const trim = notes => {
    const simMatched = notes.filter(n => n.sim >= CONFIG.start_min_sim);
    const bypass = notes.filter(n => n.sim < CONFIG.start_min_sim); // proven high-Q, low sim: always kept
    return [...adaptiveCut(simMatched, CONFIG.k), ...bypass];
  };
  // redirected_from: the slot was won by a note the arbiter has since superseded; we served
  // its replacement. A bare `superseded` flag only survives when the winner is gone, so it
  // must still read as a warning rather than as ordinary guidance.
  const flagOf = n =>
    n.status === 'needs-review' ? ' [NEEDS REVIEW, the underlying code changed; verify before use]'
      : n.status === 'superseded' ? ' [SUPERSEDED, its replacement is gone; verify before use]'
        : n.redirected_from ? ` [replaces ${n.redirected_from}, which is now superseded]`
          : '';
  const guidance = trim(passing.filter(n => n.polarity !== 'pitfall'));
  const pitfalls = trim(passing.filter(n => n.polarity === 'pitfall'));
  if (guidance.length) out += '\nMost relevant notes for this repo right now:\n';
  for (const n of guidance) {
    const block = `\n## ${n.title}${flagOf(n)}\n(type: ${n.type} · repos: ${n.repos} · files: ${n.files} · commit: ${n.source_commit})\n${n.body}\n`;
    if (out.length + block.length > MAX_CHARS) break;
    out += block;
    used.push(n);
  }
  let pitfallHeader = '\nKnown pitfalls in these repos, do NOT repeat:\n';
  for (const n of pitfalls) {
    const block = `\n## AVOID: ${n.title}${flagOf(n)}\n(type: ${n.type} · repos: ${n.repos} · files: ${n.files})\n${n.body}\n`;
    if (out.length + pitfallHeader.length + block.length > MAX_CHARS) break;
    if (pitfallHeader) { out += pitfallHeader; pitfallHeader = ''; }
    out += block;
    used.push(n);
  }
  // process.exit() does not wait for an async pipe write to flush; on Windows a
  // piped stdout write is async, so the rest of this hook (and the exit) runs
  // inside the write's own callback instead of immediately after issuing it.
  process.stdout.write(out, () => {
    try {
      // Eval sessions read memory but must not mutate retrieval state (last_used /
      // access_count ratchets would self-reinforce the notes the eval targets).
      if (process.env.UNIFIED_MEM_NO_CAPTURE === '1') return process.exit(0);
      const ts = new Date().toISOString();
      db.prepare('INSERT OR IGNORE INTO sessions (id,ts,repo,outcome,tokens_injected,summary,demo) VALUES (?,?,?,?,?,?,0)')
        .run(sessionId, ts, basename(cwd), 'indeterminate', Math.round(out.length / 4), hook.source || 'startup');
      const inj = db.prepare('INSERT INTO injections (session_id,note_id,rank,score,demo,sim,qv,rec,val) VALUES (?,?,?,?,0,?,?,?,?)');
      const touch = db.prepare('UPDATE notes SET access_count=access_count+1, last_used=? WHERE id=?');
      // pinned preferences come from a plain SELECT and carry no score/components;
      // node:sqlite rejects undefined binds (null is fine), and one bad bind would
      // kill logging for the session. Components feed offline weight-fitting.
      used.forEach((n, i) => {
        inj.run(sessionId, n.id, i + 1, n.score ?? n.q_value ?? 0, n.sim ?? null, n.q_value ?? null, n.recency ?? null, n.validity ?? null);
        touch.run(ts.slice(0, 10), n.id);
      });
    } catch (e) { hookDebugLog('retrieve', e); /* memory must never block a session */ }
    process.exit(0);
  });
} catch (e) { hookDebugLog('retrieve', e); process.exit(0); /* memory must never block a session */ }
