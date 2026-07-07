// SessionEnd hook: enqueue the session for async reflection (<100 ms, R12).
// The Phase-1 worker drains queue/ → reflector → notes. Never blocks.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT, hookDebugLog } from './vault.mjs';

try {
  // Internal headless calls (reflector, verify, judge, arbiter, eval) must never be
  // captured: they would feed the hourly reflector a stream of meta-transcripts,
  // a cost loop that reflects its own machinery. They all set one of these flags.
  if (process.env.MEMORY_OFF === '1' || process.env.UNIFIED_MEM_NO_CAPTURE === '1') process.exit(0);
  const hook = JSON.parse(readFileSync(0, 'utf8'));
  const id = hook.session_id || `unknown-${Date.now()}`;
  mkdirSync(join(VAULT, 'queue'), { recursive: true });
  writeFileSync(join(VAULT, 'queue', `${id}.json`), JSON.stringify({
    session_id: id,
    transcript_path: hook.transcript_path,
    cwd: hook.cwd,
    ts: new Date().toISOString(),
  }, null, 2));
} catch (e) { hookDebugLog('enqueue', e); /* never block */ }
process.exit(0);
