// Hermetic end-to-end smoke: temp vault, seed, then the three retrieval
// behaviors that matter (catalog on session start, relevant injection,
// chatty abstention). Exercises the exact path a fresh clone hits: this
// sequence is what caught the P0.1 crash and the P0.2 missing demo notes.
// Distinct session ids per step: session-start injects high-utility notes,
// which the per-prompt path would then correctly dedupe.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const vault = mkdtempSync(join(tmpdir(), 'umem-smoke-'));
const env = { ...process.env, UNIFIED_MEM_VAULT_DIR: vault, UNIFIED_MEM_NO_CAPTURE: '1' };
const run = (script, input) =>
  spawnSync(process.execPath, [script], { input, encoding: 'utf8', env, timeout: 60_000 });
const fail = (step, r) => {
  console.error(`SMOKE FAIL at ${step}\nstdout: ${String(r.stdout).slice(0, 400)}\nstderr: ${String(r.stderr).slice(0, 400)}`);
  process.exit(1);
};

let r = run('scripts/seed.mjs');
if (!/7 notes indexed/.test(r.stdout)) fail('seed (expected "7 notes indexed")', r);

r = run('scripts/retrieve.mjs', JSON.stringify({ session_id: 'smoke-start', cwd: tmpdir() }));
if (!r.stdout.includes('MEMORY CATALOG')) fail('session-start catalog', r);
if (!r.stdout.includes('PERSONAL PREFERENCES')) fail('pinned preferences block (demo preference should pin in any cwd)', r);

r = run('scripts/retrieve-prompt.mjs', JSON.stringify({
  session_id: 'smoke-p1', cwd: tmpdir(),
  prompt: 'why intermittent 401 bursts during jwt token refresh in api-core?',
}));
if (!/JWT/.test(r.stdout)) fail('relevant prompt should inject the JWT note', r);

r = run('scripts/retrieve-prompt.mjs', JSON.stringify({
  session_id: 'smoke-p2', cwd: tmpdir(),
  prompt: 'hey can you help me fix this thing please it is not working',
}));
if (r.stdout.trim() !== '') fail('chatty prompt must inject nothing', r);

rmSync(vault, { recursive: true, force: true });
console.log('SMOKE OK: seed, catalog, relevant injection, chatty abstention');
