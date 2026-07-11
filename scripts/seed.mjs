// Seeds vault.db with a rich, entirely FICTIONAL demo: 14 note FILES (fresh clones
// have none; notes/ is user data and gitignored), then ~6 weeks of history
// (sessions, injections, Q trajectories, consolidation diffs, daily metrics) so the
// dashboard shows a living cross-repo memory before any real data flows.
// The repos (api-core, auth-service, web-app, worker-jobs, billing, mobile-app, infra)
// and every note are invented; nothing here is tied to any real project.
// Idempotent: wipes demo rows first, never overwrites an existing note file.
// `--purge-demo` wipes rows AND deletes exactly these demo note files.
import { unlinkSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openDb, reindexNotes, NOTES_DIR } from './vault.mjs';

// Final end-state content: q_value = end of the seeded trajectory; status matches the
// metrics end-state; bodies are consistent with the seeded consolidation diffs.
const DEMO_NOTES = {
  '2026-05-26-redis-lock-pattern': `---
id: 2026-05-26-redis-lock-pattern
type: strategy
title: Redis SETNX lock pattern for cross-instance mutual exclusion
entities: [redis, concurrency]
repos: [api-core, worker-jobs]
files: [src/lib/redlock.ts]
source_commit: 2c91f04
confidence: high
q_value: 0.76
access_count: 11
last_used: 2026-07-06
last_validated: 2026-06-22
status: active
trust: demo
links: ["[[2026-05-27-jwt-refresh-race]]", "[[2026-06-17-ratelimit-redis-sliding]]"]
---
**Pattern:** For short critical sections spanning app instances, use a single-key Redis
SETNX lock (\`lock:<domain>:<id>\`) with PX TTL and a random token checked on release, not
full Redlock: one Redis is enough at our scale.
**Where it worked:** token refresh, webhook dedupe, cron leader election in worker-jobs.
**Gotchas:** Always set TTL in the same command as the acquire (SET NX PX); release via
compare-and-delete Lua script or a crashed holder's lock outlives it.
`,
  '2026-05-27-jwt-refresh-race': `---
id: 2026-05-27-jwt-refresh-race
type: recovery
title: JWT refresh race causes 401 bursts under load
entities: [jwt, redis, auth]
repos: [api-core, auth-service]
files: [src/auth/token.ts, src/middleware/refresh.ts]
source_commit: 8f3ab21
confidence: high
q_value: 0.82
access_count: 14
last_used: 2026-07-07
last_validated: 2026-06-29
status: active
trust: demo
links: ["[[2026-05-26-redis-lock-pattern]]"]
---
**Problem:** Parallel requests refreshing the same expired JWT raced; the second refresh
invalidated the first, producing intermittent 401 bursts under load.
**Root cause:** No mutual exclusion around token rotation.
**Fix:** Redis SETNX lock keyed by user-id around refresh (commit 8f3ab21). 50 ms retry, 5 s TTL.
**Gotchas:** Lock TTL must exceed p99 refresh latency; don't hold the lock across network calls to the IdP.
`,
  '2026-05-28-prefers-pnpm': `---
id: 2026-05-28-prefers-pnpm
type: preference
title: Prefers pnpm over npm and yarn in all projects
entities: []
repos: []
files: []
source_commit: user
confidence: high
q_value: 0.60
access_count: 0
last_used: null
last_validated: 2026-05-28
status: active
scope: personal
trust: demo
links: []
---
Use pnpm, never npm or yarn, for installing and running scripts in every project.
`,
  '2026-05-30-api-error-envelope': `---
id: 2026-05-30-api-error-envelope
type: convention
title: All API errors use the {error:{code,message,details}} envelope
entities: [http, api]
repos: [api-core, web-app, mobile-app]
files: [src/http/errors.ts]
source_commit: a90cc17
confidence: high
q_value: 0.80
access_count: 12
last_used: 2026-07-06
last_validated: 2026-07-03
status: active
trust: demo
links: ["[[2026-06-11-idempotency-keys-billing]]"]
---
**Convention:** Every non-2xx body is \`{ "error": { "code": string, "message": string, "details"?: object } }\`.
\`code\` is a stable SCREAMING_SNAKE slug, \`message\` is human-readable and safe to display.
**Enforced by:** \`httpError()\` helper in src/http/errors.ts; never hand-build error JSON.
**Why:** web-app and mobile-app switch on \`error.code\`; ad-hoc shapes fall through to the generic toast.
`,
  '2026-06-02-structured-logging-trace-id': `---
id: 2026-06-02-structured-logging-trace-id
type: convention
title: Every log line carries a request-scoped trace_id
entities: [observability, logging]
repos: [api-core, worker-jobs, billing]
files: [src/log/logger.ts, src/middleware/trace.ts]
source_commit: c14b8e0
confidence: high
q_value: 0.58
access_count: 5
last_used: 2026-07-02
last_validated: 2026-06-15
status: active
trust: demo
links: []
---
**Convention:** A trace_id is generated at the edge (or taken from the \`x-trace-id\` header) and
put in an AsyncLocalStorage context; the logger injects it into every JSON line automatically.
**Why:** cross-service debugging in worker-jobs and billing was impossible without a shared id.
**Gotchas:** Propagate the id explicitly across queue boundaries; ALS does not survive a Kafka hop.
`,
  '2026-06-04-ci-flaky-playwright': `---
id: 2026-06-04-ci-flaky-playwright
type: recovery
title: Playwright CI flakes from shared dev-server port collisions
entities: [ci, playwright]
repos: [web-app]
files: [playwright.config.ts, .github/workflows/e2e.yml]
source_commit: 77d1e02
confidence: med
q_value: 0.27
access_count: 2
last_used: 2026-06-19
last_validated: 2026-06-04
status: active
trust: demo
links: []
---
**Problem:** e2e jobs flaked ~15% with ECONNREFUSED; two matrix shards raced for port 3000.
**Root cause:** \`webServer.port\` hardcoded; shards shared a runner.
**Fix:** Per-shard port \`3000 + SHARD_INDEX\` and \`reuseExistingServer: false\` in CI (commit 77d1e02).
**Gotchas:** Locally \`reuseExistingServer: true\` is still wanted; gate on \`process.env.CI\`.
`,
  '2026-06-06-docker-layer-cache-ci': `---
id: 2026-06-06-docker-layer-cache-ci
type: optimization
title: Ordering Dockerfile COPY cut CI image builds 4x
entities: [docker, ci]
repos: [infra, web-app]
files: [Dockerfile, .github/workflows/build.yml]
source_commit: e0a71d5
confidence: high
q_value: 0.64
access_count: 6
last_used: 2026-07-04
last_validated: 2026-06-27
status: active
trust: demo
links: []
---
**Problem:** Every CI build reinstalled all dependencies (6 min) because \`COPY . .\` came before the install.
**Fix:** COPY only the lockfile + manifest, run install, THEN COPY the source, so the dependency
layer is cached across commits (commit e0a71d5). Build 6 min to 90 s. Also added registry cache.
**Gotchas:** Pin a base image digest or the cache silently misses on upstream retag.
`,
  '2026-06-09-kafka-consumer-rebalance': `---
id: 2026-06-09-kafka-consumer-rebalance
type: recovery
title: Kafka consumer duplicates on rebalance without cooperative sticky
entities: [kafka, concurrency]
repos: [worker-jobs, billing]
files: [src/consumers/base.ts]
source_commit: 3d5c920
confidence: high
q_value: 0.66
access_count: 7
last_used: 2026-07-05
last_validated: 2026-06-24
status: active
trust: demo
links: ["[[2026-06-11-idempotency-keys-billing]]"]
---
**Problem:** Every deploy triggered a stop-the-world rebalance; in-flight messages were reprocessed,
double-charging in billing.
**Fix:** \`partition.assignment.strategy = cooperative-sticky\` + commit offsets only after the handler
succeeds (commit 3d5c920). Pair with idempotency keys so any residual redelivery is a no-op.
**Gotchas:** Cooperative rebalancing needs every consumer in the group upgraded together.
`,
  '2026-06-11-idempotency-keys-billing': `---
id: 2026-06-11-idempotency-keys-billing
type: convention
title: Every write to the payments API takes an Idempotency-Key
entities: [billing, http, idempotency]
repos: [billing, api-core]
files: [src/payments/idempotency.ts]
source_commit: b7712a3
confidence: high
q_value: 0.71
access_count: 8
last_used: 2026-07-06
last_validated: 2026-06-30
status: active
trust: demo
links: ["[[2026-05-30-api-error-envelope]]", "[[2026-06-09-kafka-consumer-rebalance]]"]
---
**Convention:** POST/PATCH on payment resources require an \`Idempotency-Key\` header; the first
response is stored keyed by (key, route, body-hash) for 24 h and replayed on retry.
**Why:** network retries and Kafka redelivery must never double-charge a customer.
**Gotchas:** Hash the body into the key scope, or a client that reuses a key with a different amount
gets the wrong stored response.
`,
  '2026-06-14-legacy-webpack-alias': `---
id: 2026-06-14-legacy-webpack-alias
type: decision
title: Keep webpack "@lib" alias until the Vite migration completes
entities: [webpack, build]
repos: [web-app]
files: [webpack.config.js]
source_commit: 15b8d3a
confidence: low
q_value: 0.11
access_count: 1
last_used: 2026-06-14
last_validated: 2026-06-14
status: archived
trust: demo
links: []
---
**Decision:** Keep the \`@lib to src/lib\` webpack alias during the Vite migration so both bundlers
resolve imports identically.
**Rationale:** Rewriting 400+ imports mid-migration doubles review surface.
**Superseded:** Vite migration finished 2026-07-01; alias removed with webpack.config.js.
Archived by consolidator (Q 0.11 < 0.20, unused).
`,
  '2026-06-17-ratelimit-redis-sliding': `---
id: 2026-06-17-ratelimit-redis-sliding
type: optimization
title: Sliding-window rate limiter in one Redis round trip
entities: [redis, ratelimit]
repos: [api-core, auth-service]
files: [src/middleware/ratelimit.ts]
source_commit: 9aa4f18
confidence: med
q_value: 0.50
access_count: 3
last_used: 2026-07-01
last_validated: 2026-06-17
status: active
trust: demo
links: ["[[2026-05-26-redis-lock-pattern]]"]
---
**Problem:** Fixed-window limits let bursts through at the boundary and needed two Redis calls.
**Fix:** A single Lua script keeps a sorted set of timestamps and evicts + counts + adds in one
round trip (commit 9aa4f18), giving a true sliding window.
**Gotchas:** Use the Redis server clock inside the script, not the app clock, or clock skew across
app instances corrupts the window.
`,
  '2026-06-20-s3-presigned-upload': `---
id: 2026-06-20-s3-presigned-upload
type: recovery
title: Direct-to-S3 uploads need CORS + a content-length-range condition
entities: [s3, upload]
repos: [api-core, mobile-app]
files: [src/uploads/presign.ts]
source_commit: f1c88d4
confidence: med
q_value: 0.46
access_count: 2
last_used: 2026-06-30
last_validated: 2026-06-20
status: active
trust: demo
links: []
---
**Problem:** Presigned PUT uploads failed from the browser (CORS) and let clients upload 5 GB files.
**Fix:** Add a bucket CORS rule for the web origin and a \`content-length-range\` condition in the
presigned POST policy (commit f1c88d4) so oversized uploads are rejected by S3, not the app.
**Gotchas:** Presigned POST (policy conditions) enforces size; presigned PUT cannot.
`,
  '2026-06-24-feature-flag-killswitch': `---
id: 2026-06-24-feature-flag-killswitch
type: strategy
title: Ship risky changes behind a flag with a server-evaluated killswitch
entities: [feature-flags]
repos: [web-app, mobile-app]
files: [src/flags/client.ts]
source_commit: 6b2e0af
confidence: high
q_value: 0.53
access_count: 4
last_used: 2026-07-05
last_validated: 2026-06-24
status: active
trust: demo
links: []
---
**Strategy:** Every risky change ships behind a flag evaluated server-side, with a global killswitch
that overrides all targeting so an incident can be mitigated without a deploy.
**Why:** mobile-app cannot hot-fix; a bad rollout there is stuck until app-store review otherwise.
**Gotchas:** Cache flag evaluations for at most 30 s client-side, or the killswitch is not fast enough.
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
q_value: 0.56
access_count: 3
last_used: 2026-07-05
last_validated: 2026-07-01
status: needs-review
trust: demo
links: []
---
**Problem:** \`/reports?filter=\` queries scanned 2M rows; p95 was 8 s.
**Fix:** \`CREATE INDEX ... USING GIN (payload jsonb_path_ops)\` + rewrite filters to \`@>\` containment
(commit 4e77aa9). p95 to 200 ms.
**Gotchas:** jsonb_path_ops only accelerates \`@>\`, not \`?\` existence checks.
**Needs review:** src/db/reports.ts changed after this was written (commit b41c9de); verify the filter builder still uses \`@>\`.
`,
};
const DEMO_NOTE_IDS = Object.keys(DEMO_NOTES);
const notePath = id => join(NOTES_DIR, id.slice(0, 4), id.slice(5, 7), `${id}.md`);

const db = openDb();
// Refuse to seed a vault that already has real notes: trust:demo keeps fictional
// content out of session injection (see retrieve.mjs/retrieve-prompt.mjs), but
// seeding a live vault still pollutes the dashboard and confuses anyone reading
// the catalog. --force overrides for anyone who really wants a mixed vault.
// This check MUST run before any mutation below (--purge-demo is exempt: it only
// ever removes demo data, never writes it, so it stays safe on a mixed vault).
if (!process.argv.includes('--purge-demo') && !process.argv.includes('--force')) {
  const real = db.prepare("SELECT COUNT(*) c FROM notes WHERE trust != 'demo'").get().c;
  if (real > 0) {
    console.error(`refusing to seed: this vault already has ${real} real note(s). Run this only on a fresh vault (see scripts/init.mjs), or pass --force to seed anyway.`);
    process.exit(1);
  }
}
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

const LOCK = '2026-05-26-redis-lock-pattern', JWT = '2026-05-27-jwt-refresh-race',
  ENV = '2026-05-30-api-error-envelope', LOG = '2026-06-02-structured-logging-trace-id',
  CI = '2026-06-04-ci-flaky-playwright', DOCK = '2026-06-06-docker-layer-cache-ci',
  KAFKA = '2026-06-09-kafka-consumer-rebalance', IDEM = '2026-06-11-idempotency-keys-billing',
  WP = '2026-06-14-legacy-webpack-alias', RL = '2026-06-17-ratelimit-redis-sliding',
  S3 = '2026-06-20-s3-presigned-upload', FLAG = '2026-06-24-feature-flag-killswitch',
  PG = '2026-07-01-pg-jsonb-index';

// [id, day, time, repo, outcome, tokens, summary, injections:[noteId, score, dq]]
const SESSIONS = [
  ['s01', '2026-05-28', '10:12', 'api-core', 'success', 1400, 'Fix intermittent 401s on token refresh', [[JWT, .58, +.08], [LOCK, .52, +.08]]],
  ['s02', '2026-05-29', '15:40', 'worker-jobs', 'success', 1200, 'Webhook dedupe with the shared lock helper', [[LOCK, .58, +.05]]],
  ['s03', '2026-06-01', '09:05', 'api-core', 'success', 1900, 'Add refund endpoint with error envelope', [[ENV, .55, +.10], [JWT, .64, +.03]]],
  ['s04', '2026-06-03', '11:30', 'billing', 'indeterminate', 1000, 'Plan trace_id propagation across services', [[LOG, .50, 0]]],
  ['s05', '2026-06-05', '14:22', 'web-app', 'failure', 1700, 'Debug e2e matrix flakes', [[CI, .50, -.06]]],
  ['s06', '2026-06-06', '10:48', 'web-app', 'success', 1500, 'Playwright shard ports per index', [[CI, .44, +.05]]],
  ['s07', '2026-06-07', '16:02', 'infra', 'success', 1600, 'Speed up CI docker builds', [[DOCK, .52, +.09]]],
  ['s08', '2026-06-10', '09:34', 'worker-jobs', 'success', 1800, 'Stop double-processing on deploy rebalance', [[KAFKA, .54, +.09], [LOG, .52, +.03]]],
  ['s09', '2026-06-12', '13:15', 'billing', 'success', 2000, 'Idempotency keys on the charge endpoint', [[IDEM, .56, +.10], [KAFKA, .60, +.04], [ENV, .62, +.03]]],
  ['s10', '2026-06-13', '10:20', 'api-core', 'success', 1500, 'Structured logs with trace id in requests', [[LOG, .55, +.04]]],
  ['s11', '2026-06-15', '11:55', 'web-app', 'indeterminate', 900, 'Scope the Vite migration', [[WP, .44, 0]]],
  ['s12', '2026-06-16', '15:10', 'auth-service', 'success', 1600, 'Rotate signing keys without downtime', [[JWT, .67, +.06]]],
  ['s13', '2026-06-18', '09:44', 'api-core', 'success', 1700, 'Add sliding-window login rate limit', [[RL, .50, +.07], [LOCK, .66, +.03]]],
  ['s14', '2026-06-19', '14:30', 'web-app', 'failure', 1400, 'Retry flaky e2e once more', [[CI, .49, -.05]]],
  ['s15', '2026-06-21', '10:05', 'api-core', 'success', 1900, 'Direct-to-S3 avatar upload', [[S3, .50, +.06]]],
  ['s16', '2026-06-23', '16:20', 'mobile-app', 'success', 1300, 'Wire error.code toast on mobile', [[ENV, .70, +.03], [IDEM, .66, +.03]]],
  ['s17', '2026-06-25', '11:10', 'web-app', 'success', 1500, 'Ship new checkout behind a flag', [[FLAG, .50, +.07]]],
  ['s18', '2026-06-27', '09:50', 'infra', 'success', 1600, 'Pin base image digest for cache hits', [[DOCK, .61, +.05]]],
  ['s19', '2026-06-29', '13:40', 'auth-service', 'success', 2000, 'Token refresh under a load test', [[JWT, .73, +.06], [LOCK, .69, +.04], [RL, .57, +.03]]],
  ['s20', '2026-07-01', '10:20', 'api-core', 'success', 2000, 'GIN index for report filters', [[PG, .52, +.10], [ENV, .74, +.03]]],
  ['s21', '2026-07-02', '15:30', 'billing', 'success', 1700, 'Trace ids across the Kafka hop', [[LOG, .59, +.03], [KAFKA, .64, +.04]]],
  ['s22', '2026-07-04', '11:05', 'infra', 'success', 1400, 'Cron leader election lock', [[LOCK, .73, +.05], [DOCK, .66, -.03]]],
  ['s23', '2026-07-05', '09:15', 'api-core', 'failure', 1800, 'Reports filter regression after a refactor', [[PG, .62, -.06], [ENV, .77, 0]]],
  ['s24', '2026-07-07', '14:02', 'api-core', 'success', 2100, 'Charge retries stay idempotent under load', [[IDEM, .68, +.05], [JWT, .79, +.03], [ENV, .77, +.03]]],
];

const insSess = db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,1)');
// explicit columns: the injections table gained sim/qv/rec/val, so a positional
// VALUES list would break; demo rows leave those component columns null.
const insInj = db.prepare('INSERT INTO injections (session_id,note_id,rank,score,demo) VALUES (?,?,?,?,1)');
const insQ = db.prepare('INSERT INTO q_history VALUES (?,?,?,?,?,?,?,?,1)');
const q = Object.fromEntries(DEMO_NOTE_IDS.map(id => [id, .5]));

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

// weekly decay on unused notes (op='decay', no session): the flaky-CI and webpack notes fade
const DECAYS = [
  [CI, '2026-06-26T03:00:00', -.08], [WP, '2026-06-21T03:00:00', -.14],
  [CI, '2026-07-03T03:00:00', -.09], [WP, '2026-06-28T03:00:00', -.19],
];
for (const [note, ts, dq] of DECAYS) { insQ.run(note, null, ts, q[note], q[note] + dq, null, null, 'decay'); q[note] += dq; }

const CONSOLIDATIONS = [
  ['2026-06-19T03:00:00', 'merge', LOCK,
    'Merged near-duplicate 2026-06-18-redis-setnx-lock (similarity 0.91); kept richest detail, union entities, max Q',
    `--- notes/2026/06/2026-06-18-redis-setnx-lock.md (duplicate, removed)
+++ notes/2026/05/2026-05-26-redis-lock-pattern.md
-entities: [redis]
+entities: [redis, concurrency]
-**Pattern:** Use SETNX for locks.
+**Pattern:** For short critical sections spanning app instances, use a single-key Redis
+SETNX lock (\`lock:<domain>:<id>\`) with PX TTL and a random token checked on release.
+**Where it worked:** token refresh, webhook dedupe, cron leader election in worker-jobs.`],
  ['2026-06-22T03:00:00', 'autolink', IDEM,
    'Auto-linked to 2 notes: shared entities with 2026-06-09-kafka-consumer-rebalance (concurrency) and 2026-05-30-api-error-envelope (http)',
    `--- notes/2026/06/2026-06-11-idempotency-keys-billing.md
+++ notes/2026/06/2026-06-11-idempotency-keys-billing.md
-links: []
+links: ["[[2026-05-30-api-error-envelope]]", "[[2026-06-09-kafka-consumer-rebalance]]"]`],
  ['2026-06-25T03:00:00', 'coexist', RL,
    'Arbiter: 2026-06-17-ratelimit-redis-sliding vs 2026-05-26-redis-lock-pattern classified COEXISTING (same tech, different problem), both kept',
    null],
  ['2026-06-29T03:00:00', 'edit', JWT,
    'Lock TTL updated 2 s to 5 s: p99 refresh latency grew past 2 s after the IdP region move (session s19)',
    `--- notes/2026/05/2026-05-27-jwt-refresh-race.md
+++ notes/2026/05/2026-05-27-jwt-refresh-race.md
-**Fix:** Redis SETNX lock keyed by user-id around refresh (commit 8f3ab21). 50 ms retry, 2 s TTL.
+**Fix:** Redis SETNX lock keyed by user-id around refresh (commit 8f3ab21). 50 ms retry, 5 s TTL.
-last_validated: 2026-05-27
+last_validated: 2026-06-29`],
  ['2026-06-28T03:00:00', 'archive', WP,
    'Q 0.11 < 0.20 and unused 14 days; Vite migration completed to archived',
    `--- notes/2026/06/2026-06-14-legacy-webpack-alias.md
+++ notes/2026/06/2026-06-14-legacy-webpack-alias.md
-status: active
+status: archived
+**Superseded:** Vite migration finished 2026-07-01; alias removed with webpack.config.js.`],
  ['2026-07-02T03:00:00', 'invalidate', PG,
    'src/db/reports.ts changed since last_validated (commit b41c9de) to status: needs-review',
    `--- notes/2026/07/2026-07-01-pg-jsonb-index.md
+++ notes/2026/07/2026-07-01-pg-jsonb-index.md
-status: active
+status: needs-review
+**Needs review:** src/db/reports.ts changed after this was written (commit b41c9de); verify the filter builder still uses \`@>\`.`],
  ['2026-07-03T03:00:00', 'verify', ENV,
    'needs-review check passed: httpError() unchanged at HEAD, envelope shape intact to restored to active',
    `--- notes/2026/05/2026-05-30-api-error-envelope.md
+++ notes/2026/05/2026-05-30-api-error-envelope.md
-last_validated: 2026-06-24
+last_validated: 2026-07-03`],
  ['2026-07-03T03:05:00', 'decay', CI,
    'Unused 14 days: Q 0.36 to 0.27 (0.95^weeks)', null],
];
const insCons = db.prepare('INSERT INTO consolidations (ts,op,note_id,detail,diff,demo) VALUES (?,?,?,?,?,1)');
for (const c of CONSOLIDATIONS) insCons.run(...c);

// daily metrics 05-26 to 07-07 (43 days): vault grows then plateaus; stale rate stays <5%
const insM = db.prepare('INSERT OR REPLACE INTO metrics_daily VALUES (?,?,?,?,?,?,1)');
const start = new Date('2026-05-26T00:00:00Z');
const days = Array.from({ length: 43 }, (_, i) => {
  const d = new Date(start.getTime() + i * 86400000);
  return d.toISOString().slice(0, 10);
});
// active: climbs 2 to 13 as notes are created, dips 1 when webpack archives, then plateaus
const active_ = [2, 2, 3, 4, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 9, 10, 10, 11, 11, 11, 11, 11, 12, 12, 12, 12, 12, 13, 13, 13, 13, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12];
const review_ = days.map(d => d >= '2026-07-02' ? 1 : 0);
const arch_ = days.map(d => d >= '2026-06-28' ? 1 : 0);
const retrPattern = [2, 1, 0, 2, 0, 1, 1, 0, 2, 0, 3, 1, 0, 2, 1, 0, 1, 0, 2, 1, 0, 1, 3, 0, 2, 1, 0, 1, 2, 3, 1, 0, 2, 3, 0, 1, 2, 0, 1, 2, 0, 1, 4];
days.forEach((d, i) => {
  const stale = d === '2026-07-02' ? 1 : 0; // the PG injection in s20 was later superseded
  insM.run(d, active_[i], review_[i], arch_[i], stale, retrPattern[i] ?? 0);
});

console.log(`seeded: ${indexed} notes indexed, ${SESSIONS.length} demo sessions, ${CONSOLIDATIONS.length} consolidations, ${days.length} metric days`);
