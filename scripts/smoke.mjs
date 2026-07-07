// Hermetic end-to-end smoke: temp vault, seed, retrieval behaviors, AND the
// capture path. Sequence history: caught the P0.1 bind crash, the P0.2 missing
// demo notes, and (after round 3) asserts injection logging works, the exact
// path a NO_CAPTURE-only smoke was structurally blind to.
// Distinct session ids per step: session-start injects notes the per-prompt
// path would then correctly dedupe.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const vault = mkdtempSync(join(tmpdir(), 'umem-smoke-'));
const env = { ...process.env, UNIFIED_MEM_VAULT_DIR: vault, UNIFIED_MEM_NO_CAPTURE: '1' };
const envCapture = { ...env };
delete envCapture.UNIFIED_MEM_NO_CAPTURE;
const run = (args, input, e = env) =>
  spawnSync(process.execPath, args, { input, encoding: 'utf8', env: e, timeout: 60_000 });
const fail = (step, r) => {
  console.error(`SMOKE FAIL at ${step}\nstdout: ${String(r.stdout).slice(0, 400)}\nstderr: ${String(r.stderr).slice(0, 400)}`);
  process.exit(1);
};

let r = run(['scripts/seed.mjs']);
if (!/7 notes indexed/.test(r.stdout)) fail('seed (expected "7 notes indexed")', r);

r = run(['scripts/retrieve.mjs'], JSON.stringify({ session_id: 'smoke-start', cwd: tmpdir() }));
if (!r.stdout.includes('MEMORY CATALOG')) fail('session-start catalog', r);
if (r.stdout.includes('PERSONAL PREFERENCES')) fail('trust gate: demo-seeded preference must NOT pin into sessions', r);

r = run(['scripts/retrieve-prompt.mjs'], JSON.stringify({
  session_id: 'smoke-p1', cwd: tmpdir(),
  prompt: 'why intermittent 401 bursts during jwt token refresh in api-core?',
}));
if (!/JWT/.test(r.stdout)) fail('relevant prompt should inject the JWT note', r);

r = run(['scripts/retrieve-prompt.mjs'], JSON.stringify({
  session_id: 'smoke-p2', cwd: tmpdir(),
  prompt: 'hey can you help me fix this thing please it is not working',
}));
if (r.stdout.trim() !== '') fail('chatty prompt must inject nothing', r);

// A REAL preference through the real capture path, then a capture-enabled
// retrieve that must both pin it and log injection rows: Q-learning, dedupe,
// decay, and the dashboard all depend on that table being written.
r = run(['scripts/remember.mjs', 'Use tabs for indentation in every project']);
if (!/^saved: /m.test(r.stdout)) fail('remember.mjs', r);

r = run(['scripts/retrieve.mjs'], JSON.stringify({ session_id: 'smoke-capture', cwd: tmpdir() }), envCapture);
if (!r.stdout.includes('PERSONAL PREFERENCES') || !r.stdout.includes('tabs')) fail('user-explicit preference must pin', r);

r = run(['-e',
  `import('./scripts/vault.mjs').then(({openDb})=>{const c=openDb().prepare("SELECT COUNT(*) c FROM injections WHERE session_id='smoke-capture'").get().c;if(c<1){console.error('no injection rows for smoke-capture');process.exit(1)}console.log('injections logged:',c)})`,
], null, envCapture);
if (r.status !== 0) fail('capture path must log injections', r);

rmSync(vault, { recursive: true, force: true });
console.log('SMOKE OK: seed, catalog, trust gate, relevant injection, chatty abstention, pinning, capture logging');
