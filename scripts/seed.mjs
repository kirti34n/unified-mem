// Seeds vault.db: writes the six demo note FILES (fresh clones have none:
// notes/ is user data and gitignored), indexes them, then inserts 3 weeks of
// DEMO history (sessions, injections, Q trajectories, consolidation diffs,
// daily metrics) so the dashboard shows the full loop before real data flows.
// Idempotent: wipes demo rows first, never overwrites an existing note file.
// `--purge-demo` wipes rows AND deletes exactly these six note files.
import { unlinkSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openDb, reindexNotes, NOTES_DIR } from './vault.mjs';

// Final end-state content: q_value = end of the seeded trajectory, status
// matches the metrics end-state (4 active, PG needs-review, webpack archived),
// bodies consistent with the seeded consolidation diffs (JWT TTL already 5s).
const DEMO_NOTES = {
  '2026-06-16-jwt-refresh-race': `---
id: 2026-06-16-jwt-refresh-race
type: recovery
title: JWT refresh race causes 401 bursts under load
entities: [auth-service, jwt, redis]
repos: [api-core, auth-service]
files: [src/auth/token.ts, src/middleware/refresh.ts]
source_commit: 8f3ab21
confidence: high
q_value: 0.78
access_count: 9
last_used: 2026-07-07
last_validated: 2026-06-29
status: active
links: ["[[2026-06-16-redis-lock-pattern]]"]
---
**Problem:** Parallel requests refreshing the same expired JWT raced;
the second refresh invalidated the first, producing intermittent 401
bursts under load.
**Root cause:** No mutual exclusion around token rotation.
**Fix:** Redis SETNX lock keyed by user-id around refresh
(commit 8f3ab21). 50 ms retry, 5 s TTL.
**Gotchas:** Lock TTL must exceed p99 refresh latency; don't hold the
lock across network calls to the IdP.
`,
  '2026-06-16-redis-lock-pattern': `---
id: 2026-06-16-redis-lock-pattern
type: strategy
title: Redis SETNX lock pattern for cross-instance mutual exclusion
entities: [redis, concurrency]
repos: [api-core, worker-jobs]
files: [src/lib/redlock.ts]
source_commit: 2c91f04
confidence: high
q_value: 0.61
access_count: 6
last_used: 2026-07-04
last_validated: 2026-06-22
status: active
links: ["[[2026-06-16-jwt-refresh-race]]"]
---
**Pattern:** For short critical sections spanning app instances, use a
single-key Redis SETNX lock (\`lock:<domain>:<id>\`) with PX TTL and a
random token checked on release, not full Redlock, one Redis is
enough at our scale.
**Where it worked:** token refresh, webhook dedupe, cron leader
election in worker-jobs.
**Gotchas:** Always set TTL in the same command as the acquire
(SET NX PX); release via compare-and-delete Lua script or a crashed
holder's lock outlives it.
`,
  '2026-06-20-ci-flaky-playwright': `---
id: 2026-06-20-ci-flaky-playwright
type: recovery
title: Playwright CI flakes from shared dev-server port collisions
entities: [ci, playwright]
repos: [web-app]
files: [playwright.config.ts, .github/workflows/e2e.yml]
source_commit: 77d1e02
confidence: med
q_value: 0.31
access_count: 2
last_used: 2026-06-24
last_validated: 2026-06-20
status: active
links: []
---
**Problem:** e2e jobs flaked ~15% with ECONNREFUSED; two matrix shards
raced for port 3000.
**Root cause:** \`webServer.port\` hardcoded; shards shared a runner.
**Fix:** Per-shard port \`3000 + SHARD_INDEX\` in playwright.config.ts
and \`reuseExistingServer: false\` in CI (commit 77d1e02).
**Gotchas:** Locally \`reuseExistingServer: true\` is still wanted; gate
on \`process.env.CI\`.
`,
  '2026-06-24-api-error-envelope': `---
id: 2026-06-24-api-error-envelope
type: convention
title: All API errors use the {error:{code,message,details}} envelope
entities: [api, http]
repos: [api-core, web-app]
files: [src/http/errors.ts]
source_commit: a90cc17
confidence: high
q_value: 0.72
access_count: 7
last_used: 2026-07-06
last_validated: 2026-07-03
status: active
links: []
---
**Convention:** Every non-2xx response body is
\`{ "error": { "code": string, "message": string, "details"?: object } }\`.
\`code\` is a stable machine-readable slug (SCREAMING_SNAKE), \`message\`
is human-readable and safe to display.
**Enforced by:** \`httpError()\` helper in src/http/errors.ts, never
hand-build error JSON.
**Why:** web-app's global fetch wrapper switches on \`error.code\`;
ad-hoc shapes silently fall through to the generic toast.
`,
  '2026-07-01-pg-jsonb-index': `---
id: 2026-07-01-pg-jsonb-index
type: optimization
title: GIN jsonb_path_ops index makes report filters 40x faster
entities: [postgres, jsonb]
repos: [api-core]
files: [src/db/reports.ts, migrations/0042_reports_gin.sql]
source_commit: 4e77aa9
confidence: med
q_value: 0.55
access_count: 3
last_used: 2026-07-05
last_validated: 2026-07-01
status: needs-review
links: []
---
**Problem:** \`/reports?filter=\` queries scanned 2M rows; p95 was 8 s.
**Fix:** \`CREATE INDEX ... USING GIN (payload jsonb_path_ops)\` +
rewrite filters to \`@>\` containment (commit 4e77aa9). p95 → 200 ms.
**Gotchas:** jsonb_path_ops only accelerates \`@>\`, not \`?\` existence
checks, keep filter builders on containment.
**Needs review:** src/db/reports.ts changed after this was written
(commit b41c9de), verify the filter builder still uses \`@>\`.
`,
  '2026-06-18-legacy-webpack-alias': `---
id: 2026-06-18-legacy-webpack-alias
type: decision
title: Keep webpack "@lib" alias until Vite migration completes
entities: [webpack, build]
repos: [web-app]
files: [webpack.config.js]
source_commit: 15b8d3a
confidence: low
q_value: 0.12
access_count: 1
last_used: 2026-06-18
last_validated: 2026-06-18
status: archived
links: []
---
**Decision:** Keep the \`@lib → src/lib\` webpack alias during the Vite
migration so both bundlers resolve imports identically.
**Rationale:** Rewriting 400+ imports mid-migration doubles review
surface.
**Superseded:** Vite migration finished 2026-07-01; alias removed with
webpack.config.js. Archived by consolidator (Q 0.12 < 0.20, unused).
`,
};
const DEMO_NOTE_IDS = Object.keys(DEMO_NOTES);
const notePath = id => join(NOTES_DIR, id.slice(0, 4), id.slice(5, 7), `${id}.md`);

const db = openDb();
for (const t of ['sessions', 'injections', 'q_history', 'consolidations', 'metrics_daily'])
  db.exec(`DELETE FROM ${t} WHERE demo=1`);
if (process.argv.includes('--purge-demo')) {
  let removed = 0;
  for (const id of DEMO_NOTE_IDS) {
    for (const p of [db.prepare('SELECT path FROM notes WHERE id=?').get(id)?.path, notePath(id)]) {
      if (p && existsSync(p)) { try { unlinkSync(p); removed++; break; } catch { } }
    }
    db.prepare('DELETE FROM notes WHERE id=?').run(id);
  }
  reindexNotes(db);
  console.log(`demo purged: rows wiped, ${removed} fictional note files deleted`);
  process.exit(0);
}
for (const [id, content] of Object.entries(DEMO_NOTES)) {
  const p = notePath(id);
  if (existsSync(p)) continue; // never clobber: the file may have evolved
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}
const indexed = reindexNotes(db);

const JWT = '2026-06-16-jwt-refresh-race', LOCK = '2026-06-16-redis-lock-pattern',
  CI = '2026-06-20-ci-flaky-playwright', ENV = '2026-06-24-api-error-envelope',
  PG = '2026-07-01-pg-jsonb-index', WP = '2026-06-18-legacy-webpack-alias';

// [id, day, time, repo, outcome, tokens, summary, injections:[noteId, score, dq]]
const SESSIONS = [
  ['s01', '2026-06-17', '10:12', 'api-core', 'success', 1400, 'Fix intermittent 401s on token refresh', [[JWT, .58, +.08], [LOCK, .52, +.08]]],
  ['s02', '2026-06-18', '15:40', 'web-app', 'indeterminate', 900, 'Explore Vite migration plan', [[WP, .44, 0]]],
  ['s03', '2026-06-20', '09:05', 'web-app', 'failure', 1700, 'Debug e2e matrix flakes', [[CI, .49, -.06]]],
  ['s04', '2026-06-21', '11:30', 'worker-jobs', 'success', 1200, 'Webhook dedupe with shared lock helper', [[LOCK, .55, +.05], [JWT, .50, 0]]],
  ['s05', '2026-06-25', '14:22', 'api-core', 'success', 1900, 'Add refund endpoint w/ error envelope', [[ENV, .53, +.10], [JWT, .51, +.04]]],
  ['s06', '2026-06-24', '10:48', 'web-app', 'success', 1500, 'Playwright shard ports per index', [[CI, .47, +.05]]],
  ['s07', '2026-06-26', '16:02', 'api-core', 'success', 2100, 'Rate-limit login attempts', [[LOCK, .54, -.04], [JWT, .53, +.03], [ENV, .49, +.03]]],
  ['s08', '2026-06-28', '09:34', 'auth-service', 'success', 1600, 'Rotate signing keys without downtime', [[JWT, .60, +.07]]],
  ['s09', '2026-06-30', '13:15', 'api-core', 'indeterminate', 1100, 'Investigate slow /reports endpoint', [[ENV, .50, 0]]],
  ['s10', '2026-07-02', '10:20', 'api-core', 'success', 2000, 'GIN index for report filters', [[PG, .56, +.10], [ENV, .51, +.04]]],
  ['s11', '2026-07-03', '11:55', 'web-app', 'success', 1300, 'Error toast switches on error.code', [[ENV, .55, +.03]]],
  ['s12', '2026-07-04', '15:10', 'worker-jobs', 'success', 1000, 'Cron leader election lock', [[LOCK, .53, +.06]]],
  ['s13', '2026-07-05', '09:44', 'api-core', 'failure', 1800, 'Reports filter regression after refactor', [[PG, .52, -.05], [ENV, .48, 0]]],
  ['s14', '2026-07-07', '14:02', 'api-core', 'success', 2100, 'Token refresh under load test', [[JWT, .62, +.06], [LOCK, .54, -.04], [ENV, .50, +.02]]],
];

const insSess = db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,1)');
const insInj = db.prepare('INSERT INTO injections VALUES (?,?,?,?,1)');
const insQ = db.prepare('INSERT INTO q_history VALUES (?,?,?,?,?,?,?,?,1)');
const q = { [JWT]: .5, [LOCK]: .5, [CI]: .5, [ENV]: .5, [PG]: .5, [WP]: .5 };

for (const [id, day, time, repo, outcome, tokens, summary, injections] of SESSIONS) {
  const ts = `${day}T${time}:00`;
  insSess.run(id, ts, repo, outcome, tokens, summary);
  injections.forEach(([note, score, dq], i) => {
    insInj.run(id, note, i + 1, score);
    if (dq !== 0) {
      const r = outcome === 'success' ? 1 : 0;
      insQ.run(note, id, ts, q[note], q[note] + dq, Math.abs(dq) / (0.3 * Math.abs(r - q[note]) || 1), r, 'score');
      q[note] += dq;
    }
  });
}

// weekly decay on unused notes (op='decay', no session)
const DECAYS = [
  [CI, '2026-06-28T03:00:00', -.08], [WP, '2026-06-28T03:00:00', -.14],
  [CI, '2026-07-05T03:00:00', -.10], [WP, '2026-07-05T03:00:00', -.24],
];
for (const [note, ts, dq] of DECAYS) { insQ.run(note, null, ts, q[note], q[note] + dq, null, null, 'decay'); q[note] += dq; }

const CONSOLIDATIONS = [
  ['2026-06-22T03:00:00', 'merge', LOCK,
   'Merged near-duplicate 2026-06-21-redis-setnx-lock (similarity 0.91); kept richest detail, union entities, max Q',
`--- notes/2026/06/2026-06-21-redis-setnx-lock.md (duplicate, removed)
+++ notes/2026/06/2026-06-16-redis-lock-pattern.md
-entities: [redis]
+entities: [redis, concurrency]
-**Pattern:** Use SETNX for locks.
+**Pattern:** For short critical sections spanning app instances, use a
+single-key Redis SETNX lock (\`lock:<domain>:<id>\`) with PX TTL and a
+random token checked on release, not full Redlock, one Redis is
+enough at our scale.
+**Where it worked:** token refresh, webhook dedupe, cron leader
+election in worker-jobs.`],
  ['2026-06-29T03:00:00', 'edit', JWT,
   'Lock TTL updated 2s → 5s: p99 refresh latency grew past 2s after IdP region move (session s08)',
`--- notes/2026/06/2026-06-16-jwt-refresh-race.md
+++ notes/2026/06/2026-06-16-jwt-refresh-race.md
-**Fix:** Redis SETNX lock keyed by user-id around refresh
-(commit 8f3ab21). 50 ms retry, 2 s TTL.
+**Fix:** Redis SETNX lock keyed by user-id around refresh
+(commit 8f3ab21). 50 ms retry, 5 s TTL.
-last_validated: 2026-06-16
+last_validated: 2026-06-29`],
  ['2026-07-02T03:00:00', 'invalidate', PG,
   'src/db/reports.ts changed since last_validated (commit b41c9de) → status: needs-review',
`--- notes/2026/07/2026-07-01-pg-jsonb-index.md
+++ notes/2026/07/2026-07-01-pg-jsonb-index.md
-status: active
+status: needs-review
+**Needs review:** src/db/reports.ts changed after this was written
+(commit b41c9de), verify the filter builder still uses \`@>\`.`],
  ['2026-07-03T03:00:00', 'verify', ENV,
   'needs-review check passed: httpError() unchanged at HEAD, envelope shape intact → restored to active',
`--- notes/2026/06/2026-06-24-api-error-envelope.md
+++ notes/2026/06/2026-06-24-api-error-envelope.md
-last_validated: 2026-06-24
+last_validated: 2026-07-03`],
  ['2026-07-05T03:00:00', 'decay', CI,
   'Unused 11 days: Q 0.41 → 0.31 (0.95^weeks)', null],
  ['2026-07-06T03:00:00', 'archive', WP,
   'Q 0.12 < 0.20 and unused 18 days; Vite migration completed → archived',
`--- notes/2026/06/2026-06-18-legacy-webpack-alias.md
+++ notes/2026/06/2026-06-18-legacy-webpack-alias.md
-status: active
+status: archived
+**Superseded:** Vite migration finished 2026-07-01; alias removed with
+webpack.config.js. Archived by consolidator (Q 0.12 < 0.20, unused).`],
];
const insCons = db.prepare('INSERT INTO consolidations (ts,op,note_id,detail,diff,demo) VALUES (?,?,?,?,?,1)');
for (const c of CONSOLIDATIONS) insCons.run(...c);

// daily metrics 06-16 → 07-07: vault grows then plateaus; stale rate stays <5%
const insM = db.prepare('INSERT OR REPLACE INTO metrics_daily VALUES (?,?,?,?,?,?,1)');
const days = ['06-16', '06-17', '06-18', '06-19', '06-20', '06-21', '06-22', '06-23', '06-24', '06-25',
  '06-26', '06-27', '06-28', '06-29', '06-30', '07-01', '07-02', '07-03', '07-04', '07-05', '07-06', '07-07'];
const active_ = [2, 2, 3, 3, 4, 5, 4, 4, 5, 5, 5, 5, 5, 5, 5, 6, 5, 5, 5, 5, 4, 4];
const review_ = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1];
const arch_   = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1];
days.forEach((d, i) => {
  const retr = [2, 0, 1, 0, 1, 2, 0, 2, 1, 0, 3, 0, 0, 1, 1, 0, 2, 1, 1, 2, 0, 3][i];
  const stale = d === '07-02' ? 1 : 0; // the PG injection in s10 was later superseded
  insM.run(`2026-${d}`, active_[i], review_[i], arch_[i], stale, retr);
});

console.log(`seeded: ${indexed} notes indexed, ${SESSIONS.length} demo sessions, ${CONSOLIDATIONS.length} consolidations, ${days.length} metric days`);
