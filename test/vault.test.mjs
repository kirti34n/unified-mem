// Unit tests for the pure core (node:test, zero deps).
// The vault module resolves its data dir at import time, so point it at a temp
// vault BEFORE importing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.UNIFIED_MEM_VAULT_DIR = mkdtempSync(join(tmpdir(), 'umem-test-'));
const {
  parseNote, tokenize, scoreNotes, adaptiveCut, detectOutcome, makeDiff, updateNoteFile,
  validateNote, duplicateFrontmatterKey, docFreq, reindexNotes, openDb, FTS5_OK, SECRET_RE, NOTES_DIR, CONFIG,
} = await import('../scripts/vault.mjs');
const { grade } = await import('../eval/run.mjs');

const FULL_NOTE = `---
id: 2026-01-02-example-note
type: recovery
title: Example note about redis locks
entities: [redis, locking]
repos: [api-core]
files: [src/lock.ts]
source_commit: abc1234
confidence: high
q_value: 0.50
access_count: 0
last_used: null
last_validated: 2026-01-02
status: active
links: ["[[2026-01-01-other-note]]"]
---
**Problem:** things raced. **Fix:** redis SETNX lock.
`;

test('parseNote: happy path', () => {
  const n = parseNote(FULL_NOTE);
  assert.equal(n.id, '2026-01-02-example-note');
  assert.equal(n.type, 'recovery');
  assert.equal(n.title, 'Example note about redis locks');
  assert.deepEqual(n.entities, ['redis', 'locking']);
  assert.deepEqual(n.links, ['[[2026-01-01-other-note]]']);
  assert.match(n.body, /SETNX/);
});

test('parseNote: title with colon and hash preserved', () => {
  const n = parseNote('---\nid: 2026-01-02-t\ntype: decision\ntitle: fix: handle #anchor links in URLs\n---\nbody');
  assert.equal(n.title, 'fix: handle #anchor links in URLs');
});

test('parseNote: CRLF frontmatter', () => {
  const n = parseNote('---\r\nid: 2026-01-02-crlf\r\ntype: strategy\r\ntitle: t\r\n---\r\nbody');
  assert.equal(n.id, '2026-01-02-crlf');
  assert.equal(n.body, 'body');
});

test('parseNote: bracketed title is a string, not an array', () => {
  const n = parseNote('---\nid: 2026-01-02-w\ntype: decision\ntitle: [WIP] migrate build\nentities: [a, b]\n---\nbody');
  assert.equal(typeof n.title, 'string');
  assert.equal(n.title, '[WIP] migrate build');
  assert.deepEqual(n.entities, ['a', 'b']);
});

test('parseNote: body line starting status: stays in the body', () => {
  const n = parseNote('---\nid: 2026-01-02-b\ntype: convention\ntitle: t\nstatus: active\n---\nfirst line\nstatus: done was reported\nlast');
  assert.equal(n.status, 'active');
  assert.match(n.body, /status: done was reported/);
});

test('tokenize: stopwords, dedupe, length, @ retained', () => {
  const t = tokenize('The the fix for user@host and THE fix now with abc ok');
  assert.ok(!t.includes('the'));
  assert.ok(!t.includes('and'));
  assert.ok(!t.includes('ok'));           // length <= 2
  assert.ok(t.includes('user@host'));
  assert.equal(t.filter(x => x === 'fix').length, 1); // deduped
});

test('detectOutcome: pass/fail/zero-failed/checkmark', () => {
  assert.equal(detectOutcome('ran suite: 12 passed'), 'success');
  assert.equal(detectOutcome('result: 3 failed'), 'failure');
  assert.equal(detectOutcome('0 failed, 12 passed. all tests pass'), 'success');
  assert.equal(detectOutcome('did some work ✓ done'), 'indeterminate');
});

test('makeDiff: changed pair and no-change null', () => {
  const d = makeDiff('/x/a.md', 'a\nb\nc', 'a\nB\nc');
  assert.match(d, /^-b$/m);
  assert.match(d, /^\+B$/m);
  assert.equal(makeDiff('/x/a.md', 'same', 'same'), null);
});

test('SECRET_RE: hits and misses', () => {
  assert.ok(SECRET_RE.test('key sk-abcdefghijklmnop1234'));
  assert.ok(SECRET_RE.test('AKIAABCDEFGHIJKLMNOP'));
  assert.ok(SECRET_RE.test('token ghp_abcdefghijklmnopqrst'));
  assert.ok(SECRET_RE.test('-----BEGIN RSA PRIVATE KEY-----'));
  assert.ok(SECRET_RE.test('password=hunter2secret'));
  assert.ok(!SECRET_RE.test('we fixed the password reset flow'));
  assert.ok(!SECRET_RE.test('ordinary prose about api keys in general'));
});

test('validateNote: gate accepts valid, rejects malformed', () => {
  assert.equal(validateNote(parseNote(FULL_NOTE)), null);
  assert.match(validateNote(parseNote('---\nid: 2026-01-02-x\ntype: feedback\ntitle: t\n---\nbody')), /type must be/);
  assert.match(validateNote(parseNote('---\nid: not-a-date-id\ntype: recovery\ntitle: t\n---\nbody')), /id/);
  assert.match(validateNote(parseNote('---\nid: 2026-01-02-x\ntype: recovery\n---\nbody')), /title/);
  assert.match(validateNote(null), /id/);
});

// db-backed tests share one temp vault
const db = openDb();
const noteDir = join(NOTES_DIR, '2026', '01');
mkdirSync(noteDir, { recursive: true });

test('reindexNotes: note missing optional keys does not crash (P0.1)', () => {
  writeFileSync(join(noteDir, '2026-01-02-minimal.md'),
    '---\nid: 2026-01-02-minimal\ntype: convention\ntitle: minimal\nentities: [t]\nrepos: [demo]\nfiles: [x.ts]\nsource_commit: abc\nconfidence: med\nq_value: 0.50\nstatus: active\nlinks: []\n---\nBody.');
  assert.equal(reindexNotes(db) >= 1, true);
});

test('scoreNotes: archived excluded, relevant outranks unrelated, k respected', () => {
  writeFileSync(join(noteDir, '2026-01-03-redis-note.md'),
    '---\nid: 2026-01-03-redis-note\ntype: recovery\ntitle: redis lock timeout tuning\nentities: [redis]\nrepos: [demo]\nfiles: [r.ts]\nsource_commit: abc\nconfidence: med\nq_value: 0.50\nstatus: active\nlinks: []\n---\nRedis SETNX lock timeout raced under load.');
  writeFileSync(join(noteDir, '2026-01-04-css-note.md'),
    '---\nid: 2026-01-04-css-note\ntype: convention\ntitle: css grid layout rules\nentities: [css]\nrepos: [demo]\nfiles: [s.css]\nsource_commit: abc\nconfidence: med\nq_value: 0.50\nstatus: active\nlinks: []\n---\nUse css grid for page layout.');
  writeFileSync(join(noteDir, '2026-01-05-archived.md'),
    '---\nid: 2026-01-05-archived\ntype: recovery\ntitle: old redis advice\nentities: [redis]\nrepos: [demo]\nfiles: [r.ts]\nsource_commit: abc\nconfidence: med\nq_value: 0.90\nstatus: archived\nlinks: []\n---\nRedis redis redis obsolete.');
  reindexNotes(db);
  const top = scoreNotes(db, tokenize('redis lock timeout raced'), 10);
  assert.ok(!top.some(n => n.id === '2026-01-05-archived'));
  const redisRank = top.findIndex(n => n.id === '2026-01-03-redis-note');
  const cssRank = top.findIndex(n => n.id === '2026-01-04-css-note');
  assert.ok(redisRank !== -1);
  assert.ok(cssRank === -1 || redisRank < cssRank);
  assert.ok(scoreNotes(db, tokenize('redis'), 1).length <= 1);
});

test('updateNoteFile: $& in value must not expand (P1.2), frontmatter-scoped', () => {
  const p = join(noteDir, '2026-01-06-dollar.md');
  writeFileSync(p,
    '---\nid: 2026-01-06-dollar\ntype: decision\ntitle: t\nentities: [t]\nrepos: [demo]\nfiles: [x]\nsource_commit: abc\nconfidence: med\nq_value: 0.50\nstatus: active\nlinks: []\n---\nbody has\nstatus: done in prose');
  reindexNotes(db);
  updateNoteFile(db, '2026-01-06-dollar', { status: 'needs-review', last_validated: 'checked $& today' });
  const after = readFileSync(p, 'utf8');
  assert.match(after, /^status: needs-review$/m);
  assert.match(after, /^last_validated: checked \$& today$/m); // literal, not expanded
  assert.match(after, /status: done in prose/);                // body untouched
});

// ---- regression tests for the launch-readiness fixes ----

test('parseNote: leading UTF-8 BOM is tolerated', () => {
  const n = parseNote('﻿---\nid: 2026-01-02-bom\ntype: recovery\ntitle: t\n---\nbody');
  assert.equal(n?.id, '2026-01-02-bom'); // a BOM must not make the note silently unindexable
});

test('duplicateFrontmatterKey: detects a repeated key, passes clean frontmatter', () => {
  assert.equal(duplicateFrontmatterKey(FULL_NOTE), null);
  const poisoned = '---\nid: 2026-01-02-x\ntype: recovery\ntitle: t\nq_value: 0.50\nq_value: 0.95\n---\nbody';
  assert.equal(duplicateFrontmatterKey(poisoned), 'q_value'); // the Q-pinning poisoning trick is caught
});

test('grade: fact must appear AND not be a hedged non-answer', () => {
  assert.equal(grade('The fix uses a redis SETNX lock.', 'SETNX'), true);
  assert.equal(grade("I don't know the specifics, but maybe a SETNX lock helps?", 'SETNX'), false); // hedge fails
  assert.equal(grade('We never discussed Kafka here.', 'never discussed', true), true);            // negative probe
  assert.equal(grade('Totally unrelated answer.', 'SETNX'), false);                                 // keyword absent
});

test('reindexNotes: preserves DB-side last_used / access_count across a reindex', () => {
  const p = join(noteDir, '2026-01-07-usage.md');
  writeFileSync(p, '---\nid: 2026-01-07-usage\ntype: recovery\ntitle: usage note\nentities: [t]\nrepos: [demo]\nfiles: [x]\nsource_commit: abc\nconfidence: med\nq_value: 0.50\nstatus: active\nlinks: []\n---\nBody.');
  reindexNotes(db);
  // simulate a hook touch: usage state is written to the DB, never to the file
  db.prepare("UPDATE notes SET access_count=7, last_used='2026-02-01' WHERE id='2026-01-07-usage'").run();
  reindexNotes(db); // must NOT reset the counters back to the file's 0 / null
  const row = db.prepare("SELECT access_count, last_used FROM notes WHERE id='2026-01-07-usage'").get();
  assert.equal(row.access_count, 7);
  assert.equal(row.last_used, '2026-02-01');
});

test('reindexNotes: a deleted note file is reconciled out of the DB and FTS', () => {
  const p = join(noteDir, '2026-01-08-doomed.md');
  writeFileSync(p, '---\nid: 2026-01-08-doomed\ntype: recovery\ntitle: zorptastic doomed note\nentities: [zorptastic]\nrepos: [demo]\nfiles: [x]\nsource_commit: abc\nconfidence: med\nq_value: 0.50\nstatus: active\nlinks: []\n---\nBody about zorptastic.');
  reindexNotes(db);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notes WHERE id='2026-01-08-doomed'").get().c, 1);
  rmSync(p);
  reindexNotes(db);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notes WHERE id='2026-01-08-doomed'").get().c, 0); // no undead row
  if (FTS5_OK) assert.equal(db.prepare('SELECT COUNT(*) c FROM notes_fts WHERE notes_fts MATCH ?').get('"zorptastic"').c, 0);
});

test('updateNoteFile: missing note file returns null instead of throwing', () => {
  const p = join(noteDir, '2026-01-09-vanish.md');
  writeFileSync(p, '---\nid: 2026-01-09-vanish\ntype: recovery\ntitle: t\nentities: [t]\nrepos: [demo]\nfiles: [x]\nsource_commit: abc\nconfidence: med\nq_value: 0.50\nstatus: active\nlinks: []\n---\nBody.');
  reindexNotes(db);
  rmSync(p); // file gone but the row (with its path) is still present, as in the decay-after-delete race
  assert.equal(updateNoteFile(db, '2026-01-09-vanish', { status: 'needs-review' }), null);
  reindexNotes(db); // clean up the now-orphaned row so later assertions are unaffected
});

test('reindexNotes: archived notes are excluded from the FTS index', { skip: !FTS5_OK ? 'no FTS5 in this Node build' : false }, () => {
  writeFileSync(join(noteDir, '2026-01-10-archived-fts.md'),
    '---\nid: 2026-01-10-archived-fts\ntype: recovery\ntitle: quibblewick archived\nentities: [quibblewick]\nrepos: [demo]\nfiles: [x]\nsource_commit: abc\nconfidence: med\nq_value: 0.50\nstatus: archived\nlinks: []\n---\nquibblewick body.');
  reindexNotes(db);
  // archived terms must not inflate document-frequency / suppress a live note that shares them
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notes_fts WHERE notes_fts MATCH ?').get('"quibblewick"').c, 0);
});

test('export escaping: JSON-in-HTML hardening neutralizes </script>', () => {
  const escaped = JSON.stringify({ body: 'fix for </script> xss' }).replace(/</g, '\\u003c');
  assert.ok(!escaped.includes('</script>')); // cannot terminate the inline <script> on the static demo page
});

test('docFreq: keyword fallback (no FTS5) counts document frequency from the notes table', () => {
  // exercises the path taken on Node builds whose node:sqlite lacks the FTS5 module
  reindexNotes(db);
  const df = docFreq(db, ['redis', 'zzznevermatchme'], false); // force the non-FTS branch
  assert.ok(df.get('redis') >= 1);        // present in at least one active note
  assert.equal(df.get('zzznevermatchme'), 0); // absent everywhere
});

// ---- regression tests for the 2026-07-11 audit fixes ----

test('reindexNotes: access_count prefers the higher of file value and DB value', () => {
  const p = join(noteDir, '2026-01-11-access.md');
  writeFileSync(p, '---\nid: 2026-01-11-access\ntype: recovery\ntitle: access count note\nentities: [t]\nrepos: [demo]\nfiles: [x]\nsource_commit: abc\nconfidence: med\nq_value: 0.50\naccess_count: 3\nstatus: active\nlinks: []\n---\nBody.');
  reindexNotes(db); // first index: file says 3, DB had nothing → 3
  assert.equal(db.prepare("SELECT access_count FROM notes WHERE id='2026-01-11-access'").get().access_count, 3);
  db.prepare("UPDATE notes SET access_count=9 WHERE id='2026-01-11-access'").run(); // simulate hooks bumping it
  reindexNotes(db); // file still says 3 (a static template default); DB's 9 must win, not reset
  assert.equal(db.prepare("SELECT access_count FROM notes WHERE id='2026-01-11-access'").get().access_count, 9);
});

test('updateNoteFile: a BOM-prefixed note stays manageable, not permanently frozen', () => {
  const p = join(noteDir, '2026-01-12-bom-update.md');
  writeFileSync(p, '﻿---\nid: 2026-01-12-bom-update\ntype: recovery\ntitle: t\nentities: [t]\nrepos: [demo]\nfiles: [x]\nsource_commit: abc\nconfidence: med\nq_value: 0.50\nstatus: active\nlinks: []\n---\nBody.');
  reindexNotes(db);
  const diff = updateNoteFile(db, '2026-01-12-bom-update', { status: 'needs-review' });
  assert.notEqual(diff, null); // must actually apply, not silently no-op
  const after = readFileSync(p, 'utf8');
  assert.match(after, /^status: needs-review$/m);
  assert.equal(after[0], '﻿'); // BOM preserved, not corrupted
});

test('reindexNotes: q_value is clamped to the configured range', () => {
  writeFileSync(join(noteDir, '2026-01-13-hot-q.md'),
    '---\nid: 2026-01-13-hot-q\ntype: recovery\ntitle: t\nentities: [t]\nrepos: [demo]\nfiles: [x]\nsource_commit: abc\nconfidence: med\nq_value: 3.70\nstatus: active\nlinks: []\n---\nBody.');
  writeFileSync(join(noteDir, '2026-01-14-cold-q.md'),
    '---\nid: 2026-01-14-cold-q\ntype: recovery\ntitle: t\nentities: [t]\nrepos: [demo]\nfiles: [x]\nsource_commit: abc\nconfidence: med\nq_value: -1\nstatus: active\nlinks: []\n---\nBody.');
  reindexNotes(db);
  assert.equal(db.prepare("SELECT q_value FROM notes WHERE id='2026-01-13-hot-q'").get().q_value, CONFIG.q_clamp[1]);
  assert.equal(db.prepare("SELECT q_value FROM notes WHERE id='2026-01-14-cold-q'").get().q_value, CONFIG.q_clamp[0]);
});

test('reindexNotes: a blank q_value falls through to the neutral default, not the clamp floor', () => {
  writeFileSync(join(noteDir, '2026-01-18-blank-q.md'),
    '---\nid: 2026-01-18-blank-q\ntype: recovery\ntitle: t\nentities: [t]\nrepos: [demo]\nfiles: [x]\nsource_commit: abc\nconfidence: med\nq_value:\nstatus: active\nlinks: []\n---\nBody.');
  reindexNotes(db);
  assert.equal(db.prepare("SELECT q_value FROM notes WHERE id='2026-01-18-blank-q'").get().q_value, 0.5);
});

test('reindexNotes: a malformed id is dropped, not indexed with NaN scoring fields', () => {
  writeFileSync(join(noteDir, '2026-01-15-badid.md'),
    '---\nid: not-a-valid-id\ntype: recovery\ntitle: t\nentities: [t]\nrepos: [demo]\nfiles: [x]\nsource_commit: abc\nconfidence: med\nq_value: 0.50\nstatus: active\nlinks: []\n---\nBody.');
  reindexNotes(db);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notes WHERE id='not-a-valid-id'").get().c, 0);
});

test('reindexNotes: a file with a duplicated frontmatter key is skipped entirely', () => {
  const id = '2026-01-16-dupkey';
  writeFileSync(join(noteDir, `${id}.md`),
    `---\nid: ${id}\ntype: recovery\ntitle: t\nentities: [t]\nrepos: [demo]\nfiles: [x]\nsource_commit: abc\nconfidence: med\nq_value: 0.50\nq_value: 0.95\nstatus: active\nlinks: []\n---\nBody.`);
  reindexNotes(db);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notes WHERE id=?').get(id).c, 0);
});

test('reindexNotes: trust:user-explicit is preserved regardless of file location', () => {
  // A path-based restriction here was tried and reverted: it broke real,
  // legitimately hand-stamped preference notes living outside notes/personal/
  // (the reflector can never self-attest this value regardless of path, since
  // worker.mjs's provenance stamp is appended after the LLM's own frontmatter and
  // always wins under last-key-wins parsing; the only real writers are rememberNote,
  // which is safe, and the vault owner's own hand edits, which are always trusted).
  writeFileSync(join(noteDir, '2026-01-17-hand-stamped-trust.md'),
    '---\nid: 2026-01-17-hand-stamped-trust\ntype: preference\ntitle: t\nentities: [t]\nrepos: [demo]\nfiles: [x]\nsource_commit: user\nconfidence: high\nq_value: 0.50\nstatus: active\ntrust: user-explicit\nlinks: []\n---\nBody.');
  reindexNotes(db);
  assert.equal(db.prepare("SELECT trust FROM notes WHERE id='2026-01-17-hand-stamped-trust'").get().trust, 'user-explicit');
});

// ---- triggers: situation-keyed retrieval (Memento-style) ----

test('parseNote: triggers is semicolon-split, preserving commas within a phrase', () => {
  const n = parseNote('---\nid: 2026-01-19-t\ntype: recovery\ntitle: t\ntriggers: when pytest hangs on Windows, especially with subprocess; when a dev server wont die by PID\n---\nbody');
  assert.deepEqual(n.triggers, [
    'when pytest hangs on Windows, especially with subprocess',
    'when a dev server wont die by PID',
  ]);
});

test('parseNote: triggers absent is undefined, not an empty array or crash', () => {
  const n = parseNote(FULL_NOTE);
  assert.equal(n.triggers, undefined);
});

test('parseNote: triggers tolerates the LLM mimicking sibling [a, b] bracket fields', () => {
  const n = parseNote('---\nid: 2026-01-20-t\ntype: recovery\ntitle: t\ntriggers: [when pytest hangs on Windows, when a dev server wont die]\n---\nbody');
  assert.deepEqual(n.triggers, ['when pytest hangs on Windows', 'when a dev server wont die']);
});

test('parseNote: triggers strips quote marks the reflector prompt example might echo back', () => {
  const n = parseNote('---\nid: 2026-01-20-q\ntype: recovery\ntitle: t\ntriggers: "when pytest hangs on Windows"; "when a dev server wont die"\n---\nbody');
  assert.deepEqual(n.triggers, ['when pytest hangs on Windows', 'when a dev server wont die']);
});

test('parseNote: a single unbracketed triggers phrase with an internal comma is kept whole', () => {
  const n = parseNote('---\nid: 2026-01-20-c\ntype: recovery\ntitle: t\ntriggers: when the queue is empty, nothing happens\n---\nbody');
  assert.deepEqual(n.triggers, ['when the queue is empty, nothing happens']);
});

test('parseNote: an unbalanced bracket in triggers leaves no stray bracket', () => {
  assert.deepEqual(parseNote('---\nid: 2026-01-21-a\ntype: recovery\ntitle: t\ntriggers: [when x\n---\nb').triggers, ['when x']);
  assert.deepEqual(parseNote('---\nid: 2026-01-21-b\ntype: recovery\ntitle: t\ntriggers: when x]\n---\nb').triggers, ['when x']);
});

test('reindexNotes: triggers is persisted and indexed for retrieval', () => {
  writeFileSync(join(noteDir, '2026-01-19-zorblatt-trigger.md'),
    '---\nid: 2026-01-19-zorblatt-trigger\ntype: recovery\ntitle: unrelated title text\nentities: [t]\nrepos: [demo]\nfiles: [x]\nsource_commit: abc\nconfidence: med\nq_value: 0.50\nstatus: active\ntriggers: when zorblatt throws on startup\nlinks: []\n---\nBody text also unrelated.');
  reindexNotes(db);
  const row = db.prepare("SELECT triggers FROM notes WHERE id='2026-01-19-zorblatt-trigger'").get();
  assert.equal(row.triggers, 'when zorblatt throws on startup');
  // the note's title/body share no words with the query; only triggers does, so a
  // match here proves the triggers column is actually wired into retrieval, not just stored
  const top = scoreNotes(db, tokenize('zorblatt throws on startup'), 5);
  assert.ok(top.some(n => n.id === '2026-01-19-zorblatt-trigger'), FTS5_OK
    ? 'FTS5 path: triggers column must be searched'
    : 'keyword-fallback path: triggers must be included in the joined term set');
});

test('reindexNotes: multi-phrase triggers are stored with a delimiter that cannot appear inside a phrase', () => {
  writeFileSync(join(noteDir, '2026-01-20-multi-trigger.md'),
    '---\nid: 2026-01-20-multi-trigger\ntype: recovery\ntitle: t\nentities: [t]\nrepos: [demo]\nfiles: [x]\nsource_commit: abc\nconfidence: med\nq_value: 0.50\nstatus: active\ntriggers: when X, especially under Y; when Z happens\nlinks: []\n---\nBody.');
  reindexNotes(db);
  const row = db.prepare("SELECT triggers FROM notes WHERE id='2026-01-20-multi-trigger'").get();
  // a bare comma join would make "when X, especially under Y" indistinguishable
  // from two separate phrases once stored; ' | ' preserves the original boundary
  assert.equal(row.triggers, 'when X, especially under Y | when Z happens');
});

test('reindexNotes: a phrase containing the join delimiter is sanitized so the stored value stays unambiguous', () => {
  // parseNote does not forbid ' | ' inside a phrase; phraseCsv must sanitize it so a
  // re-split on ' | ' yields the correct phrase count, not a spurious extra phrase.
  writeFileSync(join(noteDir, '2026-01-22-pipe.md'),
    '---\nid: 2026-01-22-pipe\ntype: recovery\ntitle: t\nentities: [t]\nrepos: [demo]\nfiles: [x]\nsource_commit: abc\nconfidence: med\nq_value: 0.50\nstatus: active\ntriggers: run A | run B; when C fails\nlinks: []\n---\nBody.');
  reindexNotes(db);
  const stored = db.prepare("SELECT triggers FROM notes WHERE id='2026-01-22-pipe'").get().triggers;
  assert.equal(stored.split(' | ').length, 2); // exactly 2 phrases, embedded pipe sanitized to ' / '
  assert.equal(stored, 'run A / run B | when C fails');
});

test('docFreq: triggers content counts toward document frequency', () => {
  reindexNotes(db);
  const df = docFreq(db, ['zorblatt'], FTS5_OK);
  assert.ok(df.get('zorblatt') >= 1);
  const dfNoFts = docFreq(db, ['zorblatt'], false);
  assert.ok(dfNoFts.get('zorblatt') >= 1);
});

// ---- Memento adoptions: polarity, adaptive-k ----

test('adaptiveCut: cuts at a >=50% score cliff, keeps all when scores taper smoothly', () => {
  assert.equal(adaptiveCut([{ score: 0.9 }, { score: 0.85 }, { score: 0.2 }, { score: 0.15 }], 5).length, 2); // cliff after 2
  assert.equal(adaptiveCut([{ score: 0.9 }, { score: 0.8 }, { score: 0.7 }, { score: 0.6 }], 5).length, 4); // no cliff
  assert.equal(adaptiveCut([{ score: 0.5 }], 5).length, 1); // always keeps >=1
  assert.equal(adaptiveCut([], 5).length, 0);
  assert.equal(adaptiveCut([{ score: 0.9 }, { score: 0.85 }, { score: 0.8 }], 1).length, 1); // maxK respected
});

test('reindexNotes: polarity is stored, and any non-pitfall value falls back to guidance', () => {
  writeFileSync(join(noteDir, '2026-01-23-pitfall.md'),
    '---\nid: 2026-01-23-pitfall\ntype: recovery\ntitle: t\nentities: [t]\nrepos: [demo]\nfiles: [x]\nsource_commit: abc\nconfidence: med\nq_value: 0.50\nstatus: active\npolarity: pitfall\nlinks: []\n---\nBody.');
  writeFileSync(join(noteDir, '2026-01-23-garbage.md'),
    '---\nid: 2026-01-23-garbage\ntype: recovery\ntitle: t\nentities: [t]\nrepos: [demo]\nfiles: [x]\nsource_commit: abc\nconfidence: med\nq_value: 0.50\nstatus: active\npolarity: nonsense\nlinks: []\n---\nBody.');
  writeFileSync(join(noteDir, '2026-01-23-absent.md'),
    '---\nid: 2026-01-23-absent\ntype: recovery\ntitle: t\nentities: [t]\nrepos: [demo]\nfiles: [x]\nsource_commit: abc\nconfidence: med\nq_value: 0.50\nstatus: active\nlinks: []\n---\nBody.');
  reindexNotes(db);
  assert.equal(db.prepare("SELECT polarity FROM notes WHERE id='2026-01-23-pitfall'").get().polarity, 'pitfall');
  assert.equal(db.prepare("SELECT polarity FROM notes WHERE id='2026-01-23-garbage'").get().polarity, 'guidance');
  assert.equal(db.prepare("SELECT polarity FROM notes WHERE id='2026-01-23-absent'").get().polarity, 'guidance');
});

test('injections table carries component columns for offline weight-fitting', () => {
  const cols = new Set(db.prepare('PRAGMA table_info(injections)').all().map(c => c.name));
  for (const c of ['sim', 'qv', 'rec', 'val']) assert.ok(cols.has(c), `injections must have ${c} column`);
});

test('scoreNotes: returns raw components (sim, recency, validity) for injection logging', () => {
  writeFileSync(join(noteDir, '2026-01-24-comp.md'),
    '---\nid: 2026-01-24-comp\ntype: recovery\ntitle: componentcheck redis lock\nentities: [redis]\nrepos: [demo]\nfiles: [x]\nsource_commit: abc\nconfidence: med\nq_value: 0.50\nstatus: active\nlinks: []\n---\nBody about componentcheck.');
  reindexNotes(db);
  const [top] = scoreNotes(db, tokenize('componentcheck redis lock'), 1);
  assert.equal(typeof top.sim, 'number');
  assert.equal(typeof top.recency, 'number');
  assert.equal(typeof top.validity, 'number');
});
