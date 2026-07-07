// Unit tests for the pure core (node:test, zero deps).
// The vault module resolves its data dir at import time, so point it at a temp
// vault BEFORE importing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.UNIFIED_MEM_VAULT_DIR = mkdtempSync(join(tmpdir(), 'umem-test-'));
const {
  parseNote, tokenize, scoreNotes, detectOutcome, makeDiff, updateNoteFile,
  validateNote, reindexNotes, openDb, SECRET_RE, NOTES_DIR,
} = await import('../scripts/vault.mjs');

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
