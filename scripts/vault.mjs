// Shared vault library: config, schema, note parsing, FTS5 reindex, scored retrieval,
// note-file frontmatter updates + diff generation for the consolidation log.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = join(ROOT, 'index', 'vault.db');
export const NOTES_DIR = join(ROOT, 'notes');

const DEFAULTS = {
  weights: { sim: 0.40, q: 0.30, recency: 0.15, validity: 0.15 },
  k: 5, max_inject_chars: 10000, recency_half_life_days: 30,
  decay_factor_per_week: 0.95, decay_after_unused_days: 7,
  archive_below_q: 0.20, archive_unused_days: 60, active_cap_per_repo: 300,
  q_alpha: 0.3, q_delta_cap: 0.15, q_clamp: [0.05, 0.95],
  reflector_model: 'claude-sonnet-5', eval_model: 'claude-haiku-4-5-20251001',
  verify_model: 'claude-haiku-4-5-20251001', verify_cap: 5,
  prompt_k: 2, prompt_min_sim: 0.15, contribution_judge: 'llm',
  repos: {},
};
export function loadConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')) }; }
  catch { return DEFAULTS; }
}
export const CONFIG = loadConfig();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, title TEXT, type TEXT, status TEXT, confidence TEXT,
  q_value REAL, repos TEXT, entities TEXT, files TEXT, links TEXT,
  source_commit TEXT, created TEXT, last_used TEXT, last_validated TEXT,
  access_count INTEGER DEFAULT 0, body TEXT, path TEXT
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

export function openDb() {
  mkdirSync(join(ROOT, 'index'), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA busy_timeout=5000;'); // per-connection: readers wait instead of SQLITE_BUSY
  db.exec(SCHEMA);
  return db;
}

// Minimal YAML-subset frontmatter parser: `key: value` and `key: [a, b]`.
// Only known list keys parse as arrays, so a title like "[WIP] fix x" stays a string;
// inline comments are stripped everywhere except title (titles may contain '#').
const ARRAY_KEYS = new Set(['entities', 'repos', 'files', 'links']);
export function parseNote(text, path = '') {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
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
  const up = db.prepare(`INSERT OR REPLACE INTO notes
    (id,title,type,status,confidence,q_value,repos,entities,files,links,
     source_commit,created,last_used,last_validated,access_count,body,path)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  for (const p of walkNotes()) {
    const note = parseNote(readFileSync(p, 'utf8'), p);
    if (!note?.id) continue;
    const csv = x => Array.isArray(x) ? x.join(',') : (x ?? '');
    up.run(note.id, note.title ?? '', note.type ?? '', note.status ?? 'active',
      note.confidence ?? 'med', Number(note.q_value ?? 0.5), csv(note.repos),
      csv(note.entities), csv(note.files), csv(note.links), note.source_commit ?? '',
      note.id.slice(0, 10), note.last_used, note.last_validated,
      Number(note.access_count ?? 0), note.body, p);
    n++;
  }
  // rebuild FTS5 index (small vault: full rebuild is simpler than sync triggers)
  db.exec('DROP TABLE IF EXISTS notes_fts;');
  db.exec('CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, title, entities, repos, files, body);');
  const ins = db.prepare('INSERT INTO notes_fts SELECT id,title,entities,repos,files,body FROM notes');
  ins.run();
  return n;
}

export const tokenize = s =>
  [...new Set(String(s).toLowerCase().split(/[^a-z0-9@]+/).filter(w => w.length > 2))];

const VALIDITY = { active: 1.0, 'needs-review': 0.4, archived: 0 };

// FTS5/BM25 similarity per note id, normalized 0..1 (1 = best match). {} on failure.
function ftsSim(db, queryTerms) {
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
  const before = readFileSync(row.path, 'utf8');
  const fmMatch = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(before);
  if (!fmMatch) return null;
  let fm = fmMatch[2];
  for (const [key, val] of Object.entries(changes)) {
    const re = new RegExp(`^${key}:.*$`, 'm');
    fm = re.test(fm) ? fm.replace(re, `${key}: ${val}`) : fm + `\n${key}: ${val}`;
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
  const rel = path.replace(ROOT, '').replace(/\\/g, '/').replace(/^\//, '');
  const a = before.split(/\r?\n/), b = after.split(/\r?\n/);
  const out = [`--- ${rel}`, `+++ ${rel}`];
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++)
    if (a[i] !== b[i]) { if (a[i] !== undefined) out.push('-' + a[i]); if (b[i] !== undefined) out.push('+' + b[i]); }
  return out.length > 2 ? out.join('\n') : null;
}

export const SECRET_RE = /(sk-[a-zA-Z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{20,}|xox[baprs]-[a-zA-Z0-9-]+|-----BEGIN [A-Z ]*PRIVATE KEY|password\s*[:=]\s*\S+|api[_-]?key\s*[:=]\s*['"][^'"]{12,})/i;
