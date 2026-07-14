// UserPromptSubmit hook: just-in-time retrieval. The user's actual prompt is a far
// stronger query than session-start git context, and notes injected adjacent to the
// decision point get used more than ones buried at session start.
// Aggressive floor (prompt_min_sim) + dedupe vs everything already injected this
// session: MOST prompts should inject nothing. Never blocks; any failure exits 0.
import { readFileSync, appendFileSync, writeFileSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { openDb, scoreNotes, adaptiveCut, resolveSupersessions, tokenize, docFreq, hookDebugLog, CONFIG, VAULT } from './vault.mjs';

try {
  if (process.env.MEMORY_OFF === '1') process.exit(0);
  const hook = JSON.parse(readFileSync(0, 'utf8'));
  const prompt = String(hook.prompt || '');
  if (prompt.length < 25 || prompt.startsWith('/')) process.exit(0); // trivial prompts and commands: nothing to match
  if ((CONFIG.disabled_repos || []).includes(basename(hook.cwd || ''))) process.exit(0); // repo disabled in dashboard Repos view
  const db = openDb();
  const sessionId = hook.session_id || 'unknown';
  const seen = new Set(db.prepare('SELECT note_id FROM injections WHERE session_id=?')
    .all(sessionId).map(r => r.note_id));
  // Query is the PROMPT ONLY. The cwd basename must never enter it: its tokens feed
  // the DF gate below, and a repo name is by construction frequent in that repo's own
  // notes yet still under dfCap ("unified_mem" -> "unified" df=11, "mem" df=11, cap
  // 14.7), so the folder name alone satisfied the >=2-rare-terms rule for EVERY prompt.
  // That silently disabled the only precision gate on this path, in exactly the repos
  // with the most notes ("what should we have for dinner" injected 2 notes).
  const terms = tokenize(prompt).slice(0, 60); // cap: a pasted stack trace must not mean hundreds of DF queries
  const k = CONFIG.prompt_k;
  // Precision gate, frequency-aware: in a vault of fixes, words like "fix", "load",
  // "session" appear in most notes and carry zero signal. Only query terms present
  // in <=30% of notes count as evidence, and a note must contain >=2 of them.
  // A chatty prompt with no rare technical terms therefore injects NOTHING.
  const total = db.prepare('SELECT COUNT(*) c FROM notes').get().c || 1;
  const dfCap = Math.max(2, total * 0.3);
  const df = docFreq(db, terms); // FTS5 when available, else a notes-table scan (same gate on any Node)
  // The length floor mirrors the one `novel` already applies, and it is what makes the gate
  // hold on ordinary English. Document frequency alone cannot: a short common word that
  // happens to sit in only a couple of notes ("one", "blue", "day") looks exactly as
  // "discriminative" as a real technical token, so two of them satisfy the >=2 rule and a
  // chatty prompt injects. Measured on the live vault: 3 of 20 off-topic prompts leaked in
  // every repo (15.0% of 300 negative probes) purely on short words. A term has to be both
  // rare AND substantial to count as evidence.
  const rare = new Set(terms.filter(t => t.length > 4 && df.get(t) > 0 && df.get(t) <= dfCap)); // rare AND substantial: usable evidence
  const novel = terms.filter(t => df.get(t) === 0 && t.length > 4);               // vault has never seen these: the strongest gap signal
  const logGap = () => {
    if (process.env.UNIFIED_MEM_NO_CAPTURE === '1') return;
    try {
      const gapsPath = join(VAULT, 'index', 'gaps.jsonl');
      appendFileSync(gapsPath, JSON.stringify({
        ts: new Date().toISOString(), repo: basename(hook.cwd || ''),
        novel: novel.slice(0, 8), rare: [...rare].slice(0, 8),
      }) + '\n');
      // cheap probabilistic bound: trim to the most recent 2000 lines every ~100
      // appends on average, instead of a full read on every single hot-path call.
      // tmp+rename: a concurrent hook process's own appendFileSync can still land
      // between this read and the rename (a lost-update race on this low-stakes
      // telemetry log is an accepted residual), but the rename at least guarantees
      // no reader ever observes a torn/partially-written file mid-trim.
      if (Math.random() < 0.01) {
        const lines = readFileSync(gapsPath, 'utf8').split('\n').filter(Boolean);
        if (lines.length > 2000) {
          const tmp = `${gapsPath}.tmp.${process.pid}`;
          writeFileSync(tmp, lines.slice(-2000).join('\n') + '\n');
          renameSync(tmp, gapsPath);
        }
      }
    } catch { }
  };
  if (rare.size < 2) {
    if (novel.length >= 3) logGap(); // technical prompt about something the vault knows nothing about
    process.exit(0);
  }
  // trust:demo is excluded here too, not just at session-start: fictional seed
  // content must never ride into a real session via a prompt-match either.
  // Every candidate here passed the sim floor (no utility bypass on the prompt path),
  // so adaptiveCut is safe; it is applied per polarity group so a pitfall is cut on its
  // OWN cliff and never suppressed by higher-scoring guidance notes.
  // Supersede redirect runs BEFORE the seen-filter so a note already injected this session
  // cannot be re-injected via its superseded alias, and before the rare-term filter so the
  // WINNER's own text is what has to earn the slot.
  const passing = resolveSupersessions(db, scoreNotes(db, terms, k + seen.size))
    .filter(n => !seen.has(n.id) && n.sim >= CONFIG.prompt_min_sim && n.trust !== 'demo')
    .filter(n => tokenize([n.title, n.entities, n.body, n.triggers].join(' ')).filter(w => rare.has(w)).length >= 2);
  const guidanceTop = adaptiveCut(passing.filter(n => n.polarity !== 'pitfall'), k);
  const pitfallTop = adaptiveCut(passing.filter(n => n.polarity === 'pitfall'), k);
  if (!guidanceTop.length && !pitfallTop.length) {
    // the common, correct outcome. But rare terms that matched no note = a vault
    // gap: log it (unless the emptiness came from session dedupe). The gap list is
    // the evidence base for reflector tuning and the only honest embeddings trigger.
    if (seen.size === 0) logGap();
    process.exit(0);
  }

  // whole-note budget (a fraction of the session-start cap; the prompt path stays
  // compact): drop a whole note rather than slicing one off mid-sentence. Guidance
  // first, then pitfall notes in a separate "avoid these" block (Memento framing).
  const budget = Math.min(CONFIG.max_inject_chars, 6000);
  let out = 'Vault notes matching this prompt (cross-repo knowledge; verify against current code):\n';
  const injected = [];
  // redirected_from: this slot was won by a note the arbiter has since superseded; we served
  // the replacement instead. Said out loud because the agent may have seen the old note before.
  // A bare `superseded` flag only survives when the winner is gone (resolveSupersessions kept
  // the loser rather than drop the sole answer), so it must still read as a warning.
  const flagOf = n =>
    n.status === 'needs-review' ? ' [NEEDS REVIEW: underlying code changed]'
      : n.status === 'superseded' ? ' [SUPERSEDED, its replacement is gone: verify before use]'
        : n.redirected_from ? ` [replaces ${n.redirected_from}, which is now superseded]`
          : '';
  for (const n of guidanceTop) {
    const block = `\n## ${n.title}${flagOf(n)}\n(repos: ${n.repos} · files: ${n.files} · commit: ${n.source_commit})\n${n.body}\n`;
    if (out.length + block.length > budget && injected.length) break;
    out += block;
    injected.push(n);
  }
  let pitfallHeader = '\nKnown pitfalls, do NOT repeat:\n';
  for (const n of pitfallTop) {
    const block = `\n## AVOID: ${n.title}${flagOf(n)}\n(repos: ${n.repos} · files: ${n.files})\n${n.body}\n`;
    if (out.length + pitfallHeader.length + block.length > budget && injected.length) break;
    if (pitfallHeader) { out += pitfallHeader; pitfallHeader = ''; }
    out += block;
    injected.push(n);
  }
  if (!injected.length) process.exit(0);
  // process.exit() does not wait for an async pipe write to flush; on Windows a
  // piped stdout write is async, so the DB bookkeeping (and the exit) runs inside
  // the write's own callback instead of immediately after issuing it.
  process.stdout.write(out, () => {
    try {
      if (process.env.UNIFIED_MEM_NO_CAPTURE === '1') return process.exit(0); // eval reads memory, never mutates retrieval state
      const inj = db.prepare('INSERT INTO injections (session_id,note_id,rank,score,demo,sim,qv,rec,val) VALUES (?,?,?,?,0,?,?,?,?)');
      const touch = db.prepare('UPDATE notes SET access_count=access_count+1, last_used=? WHERE id=?');
      const today = new Date().toISOString().slice(0, 10);
      // components (sim/qv/rec/val) feed offline weight-fitting via tune-weights.mjs
      injected.forEach((n, i) => {
        inj.run(sessionId, n.id, 100 + i, n.score, n.sim ?? null, n.q_value ?? null, n.recency ?? null, n.validity ?? null);
        touch.run(today, n.id);
      }); // rank 100+ = per-prompt injection
    } catch (e) { hookDebugLog('retrieve-prompt', e); /* memory must never block a prompt */ }
    process.exit(0);
  });
} catch (e) { hookDebugLog('retrieve-prompt', e); process.exit(0); /* memory must never block a prompt */ }
