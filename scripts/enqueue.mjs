// SessionEnd hook: enqueue the session for async reflection (<100 ms, R12).
// The Phase-1 worker drains queue/ → reflector → notes. Never blocks.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './vault.mjs';

try {
  const hook = JSON.parse(readFileSync(0, 'utf8'));
  const id = hook.session_id || `unknown-${Date.now()}`;
  mkdirSync(join(ROOT, 'queue'), { recursive: true });
  writeFileSync(join(ROOT, 'queue', `${id}.json`), JSON.stringify({
    session_id: id,
    transcript_path: hook.transcript_path,
    cwd: hook.cwd,
    ts: new Date().toISOString(),
  }, null, 2));
} catch { /* never block */ }
process.exit(0);
