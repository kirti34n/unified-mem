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
// 15, not 14: the demo now carries the LOSER of its dedupe pair as a real note file
// (2026-06-18-redis-setnx-lock, status superseded). The engine never deletes a duplicate, it marks
// it superseded and redirects retrieval to the winner, so a demo whose duplicate simply vanished
// was showing a mechanism this system does not have.
if (!/15 notes indexed/.test(r.stdout)) fail('seed (expected "15 notes indexed")', r);

// A DEMO-ONLY vault must inject NOTHING into a real session: not the note bodies,
// not the pinned prefs, and not the MEMORY CATALOG (fictional repo names must not
// read as real cross-repo knowledge). The dashboard still shows demo data; this
// injection surface excludes it.
r = run(['scripts/retrieve.mjs'], JSON.stringify({ session_id: 'smoke-demo-only', cwd: tmpdir() }));
if (r.stdout.trim() !== '') fail('demo-only vault must inject nothing (no catalog, no prefs, no bodies)', r);

// A real (non-demo) fixture note: with a real note present, the catalog appears and
// lists the real repo, but STILL excludes the demo repos, and demo notes never ride in.
const fixtureNote = `---
id: 2026-01-15-smoke-fixture
type: recovery
title: Smoke fixture note about zorblatt config parsing
entities: [zorblatt]
triggers: when zorblatt config parsing throws on nested arrays
repos: [smoke-repo]
files: [zorblatt.ts]
source_commit: abc1234
confidence: high
q_value: 0.50
access_count: 0
last_used: null
last_validated: 2026-01-15T00:00:00Z
status: active
trust: local
links: []
---
**Problem:** zorblatt config parsing threw on nested arrays. **Fix:** flatten before parse.
`;
r = run(['-e',
  `import('./scripts/vault.mjs').then(({NOTES_DIR,openDb,reindexNotes})=>{` +
  `const fs=require('fs'),path=require('path');` +
  `const dir=path.join(NOTES_DIR,'2026','01');fs.mkdirSync(dir,{recursive:true});` +
  `fs.writeFileSync(path.join(dir,'2026-01-15-smoke-fixture.md'),process.env.FIXTURE_NOTE);` +
  `reindexNotes(openDb());console.log('fixture written');})`,
], null, { ...env, FIXTURE_NOTE: fixtureNote });
if (!/fixture written/.test(r.stdout)) fail('write smoke fixture note', r);

r = run(['scripts/retrieve.mjs'], JSON.stringify({ session_id: 'smoke-start', cwd: tmpdir() }));
if (!r.stdout.includes('MEMORY CATALOG')) fail('session-start catalog (real note present)', r);
if (!/smoke-repo/.test(r.stdout)) fail('catalog must list the real repo', r);
if (/api-core|billing|auth-service|worker-jobs/i.test(r.stdout))
  fail('trust gate: demo repo names must NOT appear in the catalog of a real session', r);
if (r.stdout.includes('PERSONAL PREFERENCES')) fail('trust gate: demo-seeded preference must NOT pin into sessions', r);
// these three demo notes have q_value >= 0.7 (0.76/0.82/0.80): before the fix they
// rode the q>=0.7 utility bypass into every session regardless of trust; check by
// rendered TITLE text (the output shows titles, not ids/slugs).
if (/SETNX lock pattern|JWT refresh race causes|errors use the/i.test(r.stdout))
  fail('trust gate: high-Q demo notes must NOT ride into a real session via the sim/bypass path', r);

r = run(['scripts/retrieve-prompt.mjs'], JSON.stringify({
  session_id: 'smoke-p1', cwd: tmpdir(),
  prompt: 'why does zorblatt config parsing throw on nested arrays?',
}));
if (!/zorblatt/i.test(r.stdout)) fail('relevant prompt should inject the fixture note', r);

// A pitfall-polarity note must render in a separate "AVOID" block (Memento negative-example framing).
const pitfallNote = `---
id: 2026-01-16-smoke-pitfall
type: recovery
title: Do not flumber the quaxel before validating it
entities: [quaxel]
triggers: when flumbering a quaxel breaks validation
polarity: pitfall
repos: [smoke-repo]
files: [quaxel.ts]
source_commit: def5678
confidence: high
q_value: 0.50
access_count: 0
last_used: null
last_validated: 2026-01-16T00:00:00Z
status: active
trust: local
links: []
---
**Problem:** flumbering a quaxel before validation corrupts it. **Fix:** validate first, then flumber.
`;
r = run(['-e',
  `import('./scripts/vault.mjs').then(({NOTES_DIR,openDb,reindexNotes})=>{` +
  `const fs=require('fs'),path=require('path');` +
  `const dir=path.join(NOTES_DIR,'2026','01');fs.mkdirSync(dir,{recursive:true});` +
  `fs.writeFileSync(path.join(dir,'2026-01-16-smoke-pitfall.md'),process.env.PITFALL_NOTE);` +
  `reindexNotes(openDb());console.log('pitfall written');})`,
], null, { ...env, PITFALL_NOTE: pitfallNote });
if (!/pitfall written/.test(r.stdout)) fail('write smoke pitfall note', r);
r = run(['scripts/retrieve-prompt.mjs'], JSON.stringify({
  session_id: 'smoke-p-pitfall', cwd: tmpdir(),
  prompt: 'what happens when flumbering a quaxel breaks validation?',
}));
if (!/AVOID:/.test(r.stdout)) fail('pitfall note must render in a separate AVOID block', r);
if (!/flumber/i.test(r.stdout)) fail('pitfall note content must be present', r);

r = run(['scripts/retrieve-prompt.mjs'], JSON.stringify({
  session_id: 'smoke-p2', cwd: tmpdir(),
  prompt: 'hey can you help me fix this thing please it is not working',
}));
if (r.stdout.trim() !== '') fail('chatty prompt must inject nothing', r);

// Same abstention, but from INSIDE the repo the notes belong to. The check above
// cannot catch a cwd leak: tmpdir()'s basename matches no note, so the query is
// effectively prompt-only there whether or not the cwd is mixed in. Here the cwd
// basename IS the fixture repo, so if it ever re-enters the query it supplies its own
// rare terms ("smoke", "repo"), every fixture note contains both, and the DF gate
// passes on any prompt at all. That is the bug this pins: the precision gate must be
// driven by the prompt alone, and must therefore stay dead in the notes' own repo.
r = run(['scripts/retrieve-prompt.mjs'], JSON.stringify({
  session_id: 'smoke-p3', cwd: join(tmpdir(), 'smoke-repo'),
  prompt: 'what should we have for dinner tonight, any thoughts on that?',
}));
if (r.stdout.trim() !== '') fail('off-topic prompt must inject nothing even inside the notes\' own repo (cwd must not enter the query)', r);

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
console.log('SMOKE OK: seed, demo-only injects nothing, catalog excludes demo repos, demo trust gate (pin + sim/bypass), real-note relevant injection, pitfall AVOID block, chatty abstention, in-repo off-topic abstention (cwd not in query), pinning, capture logging');
