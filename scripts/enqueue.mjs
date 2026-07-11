// SessionEnd + PreCompact hook: enqueue the session for async reflection (<100 ms, R12).
// The Phase-1 worker drains queue/ → reflector → notes. Never blocks. PreCompact enqueues
// mid-session (before context is summarized away), so full detail reaches the reflector
// while it still exists; SessionEnd re-enqueues the same session_id (idempotent overwrite
// of the queue file), and the worker's per-session scoreSession guard + note-id dedup keep
// the double pass from double-billing Q updates or writing duplicate notes.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { VAULT, CONFIG, hookDebugLog } from './vault.mjs';

try {
  // Internal headless calls (reflector, verify, judge, arbiter, eval) must never be
  // captured: they would feed the hourly reflector a stream of meta-transcripts,
  // a cost loop that reflects its own machinery. They all set one of these flags.
  if (process.env.MEMORY_OFF === '1' || process.env.UNIFIED_MEM_NO_CAPTURE === '1') process.exit(0);
  const hook = JSON.parse(readFileSync(0, 'utf8'));
  if ((CONFIG.disabled_repos || []).includes(basename(hook.cwd || ''))) process.exit(0); // repo disabled in dashboard Repos view
  // Sanitize before it becomes a filename (path traversal: "../../x" would escape
  // queue/) or, later, a frontmatter value the worker stamps into a note's
  // provenance block (a newline or "---" could inject fake frontmatter fields).
  const rawId = hook.session_id || `unknown-${Date.now()}`;
  const id = String(rawId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128) || `unknown-${Date.now()}`;
  mkdirSync(join(VAULT, 'queue'), { recursive: true });
  // atomic: write to .tmp then rename, so a concurrent worker drain never parses a
  // half-written file (which it would then delete, silently dropping the session)
  const dest = join(VAULT, 'queue', `${id}.json`);
  const tmp = dest + '.tmp';
  writeFileSync(tmp, JSON.stringify({
    session_id: id,
    transcript_path: hook.transcript_path,
    cwd: hook.cwd,
    ts: new Date().toISOString(),
  }, null, 2));
  renameSync(tmp, dest);
} catch (e) { hookDebugLog('enqueue', e); /* never block */ }
process.exit(0);
