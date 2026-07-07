// Shared vault library: config, schema, note parsing, FTS5 reindex, scored retrieval,
// note-file frontmatter updates + diff generation for the consolidation log.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync, statSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
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
  repos: {},
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
  mkdirSync(join(VAULT, 'index'), { recursive: true });
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
      note.id.slice(0, 10), note.last_used ?? null, note.last_validated ?? null,
      Number(note.access_count ?? 0), note.body ?? '', p);
    n++;
  }
  // rebuild FTS5 index (small vault: full rebuild is simpler than sync triggers)
  db.exec('DROP TABLE IF EXISTS notes_fts;');
  db.exec('CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, title, entities, repos, files, body);');
  const ins = db.prepare('INSERT INTO notes_fts SELECT id,title,entities,repos,files,body FROM notes');
  ins.run();
  return n;
}

// Stopwords: common English words carry no retrieval signal but match every note
// via the FTS OR-query, letting weakly-relevant notes pass the floor on chatty prompts.
const STOP = new Set(('the and for with that this have what was are you our all can how its not but now see use when why where which them they then than there here from will your know only also more some other into over after before again based make made need want just like been being were does doing done should could would about them very much still').split(' '));
export const tokenize = s =>
  [...new Set(String(s).toLowerCase().split(/[^a-z0-9@]+/).filter(w => w.length > 2 && !STOP.has(w)))];

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
  const rel = path.replace(ROOT, '').replace(/\\/g, '/').replace(/^\//, '');
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

export const NOTE_TYPES = ['recovery', 'strategy', 'optimization', 'decision', 'convention'];

// Schema gate for reflector output (untrusted). Returns null if valid, else the reason.
export function validateNote(parsed) {
  if (!parsed?.id || !/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/.test(parsed.id)) return 'invalid or missing id';
  if (!parsed.title) return 'missing title';
  if (!parsed.body) return 'missing body';
  if (!NOTE_TYPES.includes(parsed.type)) return `type must be one of: ${NOTE_TYPES.join('|')}`;
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

// Every headless pipeline call (reflect, judge, verify, arbiter) goes through here:
// hard daily budget cap, cost recorded from the CLI's own accounting, MEMORY_OFF so
// the call can never recurse into the memory system. Returns {text, usd} or null.
export function runClaude(kind, model, input, { cwd = ROOT, timeout = 180_000 } = {}) {
  const spent = todaySpendUsd();
  if (spent >= CONFIG.daily_budget_usd) {
    console.warn(`[budget] $${spent.toFixed(2)} spent today >= $${CONFIG.daily_budget_usd} cap, skipping ${kind}`);
    return null;
  }
  const r = spawnSync(`claude -p --model ${model} --output-format json --strict-mcp-config`, {
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
  try {
    mkdirSync(join(VAULT, 'index'), { recursive: true });
    appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), kind, model, usd }) + '\n');
  } catch { }
  return { text: String(j.result ?? ''), usd };
}
