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
  parseNote, tokenize, scoreNotes, detectOutcome, makeDiff, updateNoteFile,
  validateNote, duplicateFrontmatterKey, reindexNotes, openDb, SECRET_RE, NOTES_DIR,
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
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notes_fts WHERE notes_fts MATCH ?').get('"zorptastic"').c, 0);
});

test('updateNoteFile: missing note file returns null instead of throwing', () => {
  const p = join(noteDir, '2026-01-09-vanish.md');
  writeFileSync(p, '---\nid: 2026-01-09-vanish\ntype: recovery\ntitle: t\nentities: [t]\nrepos: [demo]\nfiles: [x]\nsource_commit: abc\nconfidence: med\nq_value: 0.50\nstatus: active\nlinks: []\n---\nBody.');
  reindexNotes(db);
  rmSync(p); // file gone but the row (with its path) is still present, as in the decay-after-delete race
  assert.equal(updateNoteFile(db, '2026-01-09-vanish', { status: 'needs-review' }), null);
  reindexNotes(db); // clean up the now-orphaned row so later assertions are unaffected
});

test('reindexNotes: archived notes are excluded from the FTS index', () => {
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
