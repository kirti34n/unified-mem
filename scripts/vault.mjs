// Shared vault library: config, schema, note parsing, FTS5 reindex, scored retrieval,
// note-file frontmatter updates + diff generation for the consolidation log.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync, statSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir, userInfo, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// ROOT = the tool checkout (read-only in normal operation, except config.json).
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  vault_dir: null,
  weights: { sim: 0.40, q: 0.30, recency: 0.15, validity: 0.15 },
  k: 5, max_inject_chars: 10000, recency_half_life_days: 30,
  decay_factor_per_week: 0.95, decay_after_unused_days: 7,
  archive_below_q: 0.20, archive_unused_days: 60, active_cap_per_repo: 300,
  q_alpha: 0.3, q_delta_cap: 0.15, q_clamp: [0.05, 0.95],
  reflector_model: 'claude-sonnet-5', eval_model: 'claude-haiku-4-5-20251001',
  verify_model: 'claude-haiku-4-5-20251001', verify_cap: 5,
  prompt_k: 2, prompt_min_sim: 0.15, start_min_sim: 0.2, contribution_judge: 'llm',
  daily_budget_usd: 5, max_reflections_per_run: 10,
  personal_budget_chars: 800, preference_cap: 30,
  repos: {}, disabled_repos: [],
};
export function loadConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')) }; }
  catch { return DEFAULTS; }
}
export const CONFIG = loadConfig();

// VAULT = where the user's data lives (its own git repo: notes tracked, caches not).
// Resolution: env override (tests) > config.vault_dir > back-compat in-repo layout
// (a ./notes dir in the tool checkout, pre-split installs) > ~/.unified-mem/vault.
const expandHome = p => p.replace(/^~(?=[\\/]|$)/, homedir());
export const DEFAULT_VAULT = join(homedir(), '.unified-mem', 'vault');
export const VAULT = (() => {
  if (process.env.UNIFIED_MEM_VAULT_DIR) return resolve(expandHome(process.env.UNIFIED_MEM_VAULT_DIR));
  if (CONFIG.vault_dir) return resolve(expandHome(CONFIG.vault_dir));
  if (existsSync(join(ROOT, 'notes'))) {
    if (process.env.UNIFIED_MEM_DEBUG === '1')
      console.error('unified-mem: using legacy in-checkout vault layout; set vault_dir in config.json to split data from the tool (see scripts/init.mjs)');
    return ROOT;
  }
  return DEFAULT_VAULT;
})();
export const DB_PATH = join(VAULT, 'index', 'vault.db');
export const NOTES_DIR = join(VAULT, 'notes');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, title TEXT, type TEXT, status TEXT, confidence TEXT,
  q_value REAL, repos TEXT, entities TEXT, files TEXT, links TEXT,
  source_commit TEXT, created TEXT, last_used TEXT, last_validated TEXT,
  access_count INTEGER DEFAULT 0, body TEXT, path TEXT, scope TEXT DEFAULT 'shared',
  trust TEXT DEFAULT 'unknown'
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, ts TEXT, repo TEXT, outcome TEXT,
  tokens_injected INTEGER, summary TEXT, demo INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS injections (
  session_id TEXT, note_id TEXT, rank INTEGER, score REAL, demo INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS q_history (
  note_id TEXT, session_id TEXT, ts TEXT, old_q REAL, new_q REAL,
  contribution REAL, reward INTEGER, op TEXT DEFAULT 'score', demo INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS consolidations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, op TEXT, note_id TEXT,
  detail TEXT, diff TEXT, demo INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS metrics_daily (
  date TEXT PRIMARY KEY, active INTEGER, needs_review INTEGER, archived INTEGER,
  stale_retrievals INTEGER, retrievals INTEGER, demo INTEGER DEFAULT 0
);
`;

// node:sqlite bundles SQLite, but the FTS5 module was only compiled into the
// bundle from a later build (Node 22.13, the version where node:sqlite unflagged,
// ships without it). Probe once: when FTS5 is present we use BM25 ranking; when it
// is absent we degrade to keyword scoring so the vault still works, just less
// precisely. UNIFIED_MEM_NO_FTS=1 forces the fallback (used to test that path).
export const FTS5_OK = process.env.UNIFIED_MEM_NO_FTS === '1' ? false : (() => {
  try { const d = new DatabaseSync(':memory:'); d.exec('CREATE VIRTUAL TABLE t USING fts5(x);'); d.close(); return true; }
  catch { return false; }
})();

export function openDb() {
  mkdirSync(join(VAULT, 'index'), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA busy_timeout=5000;'); // per-connection: readers wait instead of SQLITE_BUSY
  db.exec(SCHEMA);
  try { db.exec("ALTER TABLE notes ADD COLUMN scope TEXT DEFAULT 'shared'"); } catch { } // migration for pre-P3 vaults
  try { db.exec("ALTER TABLE notes ADD COLUMN trust TEXT DEFAULT 'unknown'"); } catch { } // trust gates pinning + utility bypass
  return db;
}

// Minimal YAML-subset frontmatter parser: `key: value` and `key: [a, b]`.
// Only known list keys parse as arrays, so a title like "[WIP] fix x" stays a string;
// inline comments are stripped everywhere except title (titles may contain '#').
const ARRAY_KEYS = new Set(['entities', 'repos', 'files', 'links']);
export function parseNote(text, path = '') {
  // tolerate a leading UTF-8 BOM (Notepad / some PowerShell redirects add one),
  // else the ^--- anchor misses and a hand-edited note silently drops from the index.
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (ARRAY_KEYS.has(kv[1]) && v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      if (kv[1] !== 'title') v = v.replace(/\s+#.*$/, '');
      v = v.replace(/^["']|["']$/g, '');
      if (v === 'null' || v === '') v = null;
    }
    meta[kv[1]] = v;
  }
  return { ...meta, body: m[2].trim(), path };
}

export function* walkNotes(dir = NOTES_DIR) {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walkNotes(p);
    else if (e.endsWith('.md')) yield p;
  }
}

export function reindexNotes(db) {
  // last_used / access_count are written to the DB by the hooks but never mirrored
  // into the note files, so a plain upsert from files would reset usage every run
  // (silently degrading the recency term). Preserve the DB-side counters.
  const prior = new Map(db.prepare('SELECT id, last_used, access_count FROM notes').all()
    .map(r => [r.id, r]));
  const up = db.prepare(`INSERT OR REPLACE INTO notes
    (id,title,type,status,confidence,q_value,repos,entities,files,links,
     source_commit,created,last_used,last_validated,access_count,body,path,scope,trust)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const seen = [];
  let n = 0;
  for (const p of walkNotes()) {
    const note = parseNote(readFileSync(p, 'utf8'), p);
    if (!note?.id) continue;
    const was = prior.get(note.id);
    const csv = x => Array.isArray(x) ? x.join(',') : (x ?? '');
    up.run(note.id, note.title ?? '', note.type ?? '', note.status ?? 'active',
      note.confidence ?? 'med', Number(note.q_value ?? 0.5), csv(note.repos),
      csv(note.entities), csv(note.files), csv(note.links), note.source_commit ?? '',
      note.id.slice(0, 10), note.last_used ?? was?.last_used ?? null, note.last_validated ?? null,
      Number(note.access_count ?? was?.access_count ?? 0), note.body ?? '', p, note.scope ?? 'shared', note.trust ?? 'unknown');
    seen.push(note.id);
    n++;
  }
  // Reconcile deletions: a note whose file was removed on disk must not linger in
  // the DB, else it keeps being injected and later crashes decay via its missing path.
  if (seen.length) db.prepare(`DELETE FROM notes WHERE id NOT IN (${seen.map(() => '?').join(',')})`).run(...seen);
  else db.prepare('DELETE FROM notes').run();
  // rebuild FTS5 index (small vault: full rebuild is simpler than sync triggers).
  // Transactional: a concurrent hook read must never observe a missing notes_fts.
  // Archived notes are excluded: they are never retrieved, and indexing them only
  // inflates document-frequency and can suppress a live note that shares a term.
  // Skipped entirely when FTS5 is unavailable (retrieval falls back to keyword scoring).
  if (FTS5_OK) {
    db.exec('BEGIN');
    try {
      db.exec('DROP TABLE IF EXISTS notes_fts;');
      db.exec('CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, title, entities, repos, files, body);');
      db.prepare("INSERT INTO notes_fts SELECT id,title,entities,repos,files,body FROM notes WHERE status != 'archived'").run();
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { } throw e; }
  }
  return n;
}

// Document frequency per term, used by the per-prompt precision gate. Uses the FTS5
// index when available (fast), else scans the notes table (fine at vault scale), so
// the gate works identically on Node builds without FTS5. useFts is overridable for tests.
export function docFreq(db, terms, useFts = FTS5_OK) {
  if (useFts) {
    return new Map(terms.map(t => {
      try { return [t, db.prepare('SELECT COUNT(*) c FROM notes_fts WHERE notes_fts MATCH ?').get(`"${t.replace(/"/g, '')}"`).c]; }
      catch { return [t, 0]; }
    }));
  }
  const rows = db.prepare("SELECT title,entities,repos,files,body FROM notes WHERE status != 'archived'").all();
  const docs = rows.map(r => new Set(tokenize([r.title, r.entities, r.repos, r.files, r.body].join(' '))));
  return new Map(terms.map(t => [t, docs.filter(s => s.has(t)).length]));
}

// Stopwords: common English words carry no retrieval signal but match every note
// via the FTS OR-query, letting weakly-relevant notes pass the floor on chatty prompts.
const STOP = new Set(('the and for with that this have what was are you our all can how its not but now see use when why where which them they then than there here from will your know only also more some other into over after before again based make made need want just like been being were does doing done should could would about them very much still').split(' '));
export const tokenize = s =>
  [...new Set(String(s).toLowerCase().split(/[^a-z0-9@]+/).filter(w => w.length > 2 && !STOP.has(w)))];

const VALIDITY = { active: 1.0, 'needs-review': 0.4, archived: 0 };

// FTS5/BM25 similarity per note id, normalized 0..1 (1 = best match). {} when FTS5
// is unavailable or on failure, which makes scoreNotes fall back to keyword overlap.
function ftsSim(db, queryTerms) {
  if (!FTS5_OK) return {};
  try {
    const match = queryTerms.map(t => `"${t.replace(/"/g, '')}"`).join(' OR ');
    if (!match) return {};
    const rows = db.prepare('SELECT id, bm25(notes_fts) r FROM notes_fts WHERE notes_fts MATCH ?').all(match);
    if (!rows.length) return {};
    const best = Math.min(...rows.map(r => r.r)); // bm25: more negative = better
    return Object.fromEntries(rows.map(r => [r.id, best < 0 ? r.r / best : 0]));
  } catch { return {}; }
}

// score = w.sim·similarity + w.q·q_value + w.recency·recency + w.validity·validity  (PLAN §4.2)
export function scoreNotes(db, queryTerms, k = CONFIG.k, now = new Date()) {
  const rows = db.prepare('SELECT * FROM notes').all();
  const raw = CONFIG.weights;
  const wsum = raw.sim + raw.q + raw.recency + raw.validity || 1;
  const w = { sim: raw.sim / wsum, q: raw.q / wsum, recency: raw.recency / wsum, validity: raw.validity / wsum }; // any config normalizes to 1
  const sims = ftsSim(db, queryTerms);
  const q = new Set(queryTerms);
  return rows.map(n => {
    const validity = VALIDITY[n.status] ?? 0.4;
    if (validity === 0) return null;
    let sim = sims[n.id];
    if (sim === undefined && !Object.keys(sims).length) { // FTS unavailable → keyword fallback
      const terms = tokenize([n.title, n.entities, n.repos, n.files, n.body].join(' '));
      sim = Math.min(1, terms.filter(t => q.has(t)).length / Math.sqrt((q.size || 1) * (terms.length || 1)) * 6);
    }
    sim ??= 0;
    const ref = new Date(n.last_used || n.created || now);
    const ageDays = Math.max(0, (now - ref) / 86400000);
    const recency = Math.exp(-ageDays * Math.LN2 / CONFIG.recency_half_life_days);
    const score = w.sim * sim + w.q * n.q_value + w.recency * recency + w.validity * validity;
    return { ...n, score, sim };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, k);
}

// Update frontmatter keys in a note file (and mirror to db); returns a unified-style diff.
// Edits are scoped to the frontmatter block only, so a body line starting with
// "status:" can never be clobbered.
export function updateNoteFile(db, id, changes) {
  const row = db.prepare('SELECT path FROM notes WHERE id=?').get(id);
  if (!row?.path) return null;
  let before;
  try { before = readFileSync(row.path, 'utf8'); }
  catch { return null; } // file deleted out from under us: skip; reindex reconciles the row
  const fmMatch = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(before);
  if (!fmMatch) return null;
  let fm = fmMatch[2];
  for (const [key, val] of Object.entries(changes)) {
    const re = new RegExp(`^${key}:.*$`, 'm');
    // replacer FUNCTION: a value containing $&, $' etc. must not expand as a replacement pattern
    fm = re.test(fm) ? fm.replace(re, () => `${key}: ${val}`) : fm + `\n${key}: ${val}`;
  }
  const fmStart = fmMatch.index + fmMatch[1].length;
  const after = before.slice(0, fmStart) + fm + before.slice(fmStart + fmMatch[2].length);
  writeFileSync(row.path, after);
  const cols = ['status', 'q_value', 'last_used', 'last_validated', 'access_count', 'confidence'];
  for (const [key, val] of Object.entries(changes))
    if (cols.includes(key)) db.prepare(`UPDATE notes SET ${key}=? WHERE id=?`).run(val, id);
  return makeDiff(row.path, before, after);
}

// Minimal line diff: paired -/+ for changed lines (frontmatter edits keep line counts).
export function makeDiff(path, before, after) {
  const rel = path.replace(VAULT, '').replace(ROOT, '').replace(/\\/g, '/').replace(/^\//, ''); // never leak absolute paths into diffs
  const a = before.split(/\r?\n/), b = after.split(/\r?\n/);
  const out = [`--- ${rel}`, `+++ ${rel}`];
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++)
    if (a[i] !== b[i]) { if (a[i] !== undefined) out.push('-' + a[i]); if (b[i] !== undefined) out.push('+' + b[i]); }
  return out.length > 2 ? out.join('\n') : null;
}

export const SECRET_RE = /(sk-[a-zA-Z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{20,}|xox[baprs]-[a-zA-Z0-9-]+|-----BEGIN [A-Z ]*PRIVATE KEY|password\s*[:=]\s*\S+|api[_-]?key\s*[:=]\s*['"][^'"]{12,})/i;

// Hooks swallow every error by design (memory must never block a session).
// UNIFIED_MEM_DEBUG=1 is the escape hatch: failures land in hook-errors.jsonl.
export function hookDebugLog(script, err) {
  if (process.env.UNIFIED_MEM_DEBUG !== '1') return;
  try {
    mkdirSync(join(VAULT, 'index'), { recursive: true });
    appendFileSync(join(VAULT, 'index', 'hook-errors.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), script, err: String(err?.stack || err) }) + '\n');
  } catch { }
}

// preference: short rules about the user (personal scope, pinned at session start).
// reference: chunks ingested from the user's own docs (matched per prompt like any note).
export const NOTE_TYPES = ['recovery', 'strategy', 'optimization', 'decision', 'convention', 'preference', 'reference'];

// Schema gate for untrusted note content. Returns null if valid, else the reason.
// Callers narrow allowedTypes: the reflector may only emit its five knowledge
// types, never preference/reference (a poisoned transcript must not be able to
// plant a note that gets pinned into every session).
export function validateNote(parsed, allowedTypes = NOTE_TYPES) {
  if (!parsed?.id || !/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/.test(parsed.id)) return 'invalid or missing id';
  if (!parsed.title) return 'missing title';
  if (!parsed.body) return 'missing body';
  if (!allowedTypes.includes(parsed.type)) return `type must be one of: ${allowedTypes.join('|')}`;
  return null;
}

// A duplicated frontmatter key is a poisoning trick: the reflector output is forced
// to neutral q_value/scope by a per-line rewrite, but a SECOND q_value line survives
// it and, since parsing is last-key-wins, the note can index at Q 0.95 and ride the
// utility bypass into every session. Reject any note whose frontmatter repeats a key.
export function duplicateFrontmatterKey(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const seen = new Set();
  for (const line of m[1].split(/\r?\n/)) {
    const k = /^([\w-]+):/.exec(line)?.[1];
    if (!k) continue;
    if (seen.has(k)) return k;
    seen.add(k);
  }
  return null;
}

// Verifiable-outcome heuristic (R5). Deliberately conservative: a bare checkmark
// is NOT a success signal (Claude Code output is full of them), "0 failed" is not
// a failure. LLM judgment only ever refines contribution, never the outcome.
export function detectOutcome(text) {
  const tail = text.slice(-8000);
  if (/(\d+ (passed|passing)|all tests pass|tests? (pass|green)|build succeeded|verified working)/i.test(tail)
    && !/[1-9]\d* (failed|failing)/i.test(tail)) return 'success';
  if (/([1-9]\d* (failed|failing)|build failed|tests? fail|FATAL|unhandled exception)/i.test(tail)) return 'failure';
  return 'indeterminate';
}

// Explicit personal capture, shared by the vault_remember MCP tool and the
// remember.mjs CLI. Same gates as the reflector (schema, secrets, size);
// provenance is stamped here, never trusted from the caller. Preferences start
// at Q 0.6: an explicit user statement outranks a freshly distilled guess.
export function rememberNote(text, { kind = 'preference', title = null, sessionId = 'user-explicit' } = {}) {
  text = String(text || '').trim();
  if (!text) throw new Error('empty text');
  if (text.split(/\s+/).length > 150) throw new Error('too long: 150 words max for a remembered note');
  if (SECRET_RE.test(text)) throw new Error('secret pattern detected: not stored');
  const type = kind === 'preference' ? 'preference' : 'convention';
  const t = (title || text).replace(/\s+/g, ' ').trim().slice(0, 80);
  const slug = t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .split('-').slice(0, 6).join('-') || 'note';
  const today = new Date().toISOString().slice(0, 10);
  const db = openDb();
  let id = `${today}-${slug}`;
  let i = 2;
  while (db.prepare('SELECT 1 FROM notes WHERE id=?').get(id)) id = `${today}-${slug}-${i++}`;
  const note = `---
id: ${id}
type: ${type}
title: ${t}
entities: []
repos: []
files: []
source_commit: user
confidence: high
q_value: ${kind === 'preference' ? '0.60' : '0.50'}
access_count: 0
last_used: null
last_validated: ${today}
status: active
scope: personal
author: ${userInfo().username}
machine: ${hostname()}
source_session: ${sessionId}
trust: user-explicit
links: []
---
${text}
`;
  const invalid = validateNote(parseNote(note), ['preference', 'convention']);
  if (invalid) throw new Error(invalid);
  const dir = join(NOTES_DIR, 'personal');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), note);
  reindexNotes(db);
  return id;
}

// ---- LLM pipeline calls: one path, budget-guarded, cost-ledgered ----
const LEDGER = join(VAULT, 'index', 'cost-ledger.jsonl');

export function todaySpendUsd() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    return readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && e.ts?.startsWith(today))
      .reduce((s, e) => s + (e.usd || 0), 0);
  } catch { return 0; }
}

// Record one pipeline call's cost. Shared by runClaude and the eval harness so every
// LLM call (including eval, which can't route through runClaude because it needs
// memory ON for arm A) lands in the same ledger and counts against the daily cap.
export function appendLedger(kind, model, usd) {
  try {
    mkdirSync(join(VAULT, 'index'), { recursive: true });
    appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), kind, model, usd }) + '\n');
  } catch { }
}

// Every headless pipeline call (reflect, judge, verify, arbiter) goes through here:
// hard daily budget cap, cost recorded from the CLI's own accounting, MEMORY_OFF so
// the call can never recurse into the memory system. Returns {text, usd} or null.
// `tools` restricts what the headless model may do while chewing on UNTRUSTED
// transcript/note content: 'none' denies every built-in tool (reflect/judge need
// zero tools), an array is an explicit read-only allowlist (verify reads code).
const BUILTIN_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite'];
export function runClaude(kind, model, input, { cwd = ROOT, timeout = 180_000, tools = null } = {}) {
  const spent = todaySpendUsd();
  if (spent >= CONFIG.daily_budget_usd) {
    console.warn(`[budget] $${spent.toFixed(2)} spent today >= $${CONFIG.daily_budget_usd} cap, skipping ${kind}`);
    return null;
  }
  const toolFlag = tools === 'none' ? ` --disallowed-tools ${BUILTIN_TOOLS.join(' ')}`
    : Array.isArray(tools) ? ` --allowed-tools ${tools.join(' ')}` : '';
  const r = spawnSync(`claude -p --model ${model} --output-format json --strict-mcp-config${toolFlag}`, {
    input, encoding: 'utf8', shell: true, timeout, cwd,
    env: { ...process.env, MEMORY_OFF: '1' },
  });
  if (r.status !== 0) {
    // with --output-format json the CLI reports errors on stdout ({is_error, result}), stderr stays empty
    let detail = String(r.stderr || '').slice(0, 200);
    try { detail = JSON.parse(r.stdout).result?.slice(0, 200) || detail; } catch { }
    console.error(`${kind} failed (${r.status}): ${detail}`);
    if (/model|not found|invalid|no access/i.test(detail))
      console.error(`hint: model '${model}' was rejected. Check reflector_model / verify_model / eval_model in config.json against the models list at docs.claude.com`);
    return null;
  }
  let j;
  try { j = JSON.parse(r.stdout); } catch { return { text: String(r.stdout || ''), usd: 0 }; }
  const usd = j.total_cost_usd ?? 0;
  appendLedger(kind, model, usd);
  return { text: String(j.result ?? ''), usd };
}
