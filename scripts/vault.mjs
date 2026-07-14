// Shared vault library: config, schema, note parsing, FTS5 reindex, scored retrieval,
// note-file frontmatter updates + diff generation for the consolidation log.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync, statSync, writeFileSync, appendFileSync, existsSync, renameSync } from 'node:fs';
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
// config.json lives in a stable home dir (~/.unified-mem) so it survives plugin
// updates, which replace the ephemeral plugin install dir. A legacy in-checkout
// config.json is still honored, so existing manual installs keep working unchanged.
export const CONFIG_PATH = existsSync(join(ROOT, 'config.json'))
  ? join(ROOT, 'config.json')
  : join(homedir(), '.unified-mem', 'config.json');
export function loadConfig() {
  // weights is deep-merged: a config that hand-tunes only one weight (e.g. {"sim":0.6})
  // must not leave the other three undefined, which silently turns every score into NaN.
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULTS, ...parsed, weights: { ...DEFAULTS.weights, ...(parsed.weights || {}) } };
  } catch { return DEFAULTS; }
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
  trust TEXT DEFAULT 'unknown', triggers TEXT DEFAULT '', polarity TEXT DEFAULT 'guidance'
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, ts TEXT, repo TEXT, outcome TEXT,
  tokens_injected INTEGER, summary TEXT, demo INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS injections (
  session_id TEXT, note_id TEXT, rank INTEGER, score REAL, demo INTEGER DEFAULT 0,
  sim REAL, qv REAL, rec REAL, val REAL
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
  try { db.exec("ALTER TABLE notes ADD COLUMN triggers TEXT DEFAULT ''"); } catch { } // situation phrases, optional
  try { db.exec("ALTER TABLE notes ADD COLUMN polarity TEXT DEFAULT 'guidance'"); } catch { } // guidance vs pitfall (negative-example framing)
  try { db.exec("ALTER TABLE notes ADD COLUMN superseded_by TEXT DEFAULT ''"); } catch { } // set by the dedupe arbiter; named in the injected block so a demoted note can't mislead
  // injection component scores (for offline weight-fitting via tune-weights.mjs)
  for (const c of ['sim', 'qv', 'rec', 'val'])
    try { db.exec(`ALTER TABLE injections ADD COLUMN ${c} REAL`); } catch { }
  return db;
}

// Minimal YAML-subset frontmatter parser: `key: value` and `key: [a, b]`.
// Only known list keys parse as arrays, so a title like "[WIP] fix x" stays a string;
// inline comments are stripped everywhere except title (titles may contain '#').
const ARRAY_KEYS = new Set(['entities', 'repos', 'files', 'links']);
// triggers holds short natural-language SITUATION phrases (Memento-style: retrieval
// keyed to when a note applies, not just what it says), which routinely contain
// commas of their own ("when X, especially under Y"); a semicolon-delimited plain
// line avoids the bracketed comma-split ARRAY_KEYS uses, which would mangle them.
const PHRASE_KEYS = new Set(['triggers']);
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
    } else if (PHRASE_KEYS.has(kv[1])) {
      // Defensive against the LLM mimicking its OWN sibling fields (entities/repos/
      // files/links are all shown as bracketed [a, b] elsewhere in the same reflector
      // template): a wrapping [ ] pair is stripped first. ';' is the intended phrase
      // delimiter (chosen because a phrase may contain a comma of its own); only fall
      // back to splitting on ',' when the value was ALSO bracket-wrapped (clear
      // evidence of sibling-format mimicry) so a single unbracketed phrase with an
      // internal comma and no semicolon is correctly kept as ONE phrase, not split.
      // Each phrase is quote-stripped like every other field's elements are.
      const bracketed = v.startsWith('[') && v.endsWith(']');
      if (bracketed) v = v.slice(1, -1).trim();
      const parts = v.includes(';') ? v.split(';') : bracketed ? v.split(',') : [v];
      // strip a stray leading '[' / trailing ']' too (an UNBALANCED bracket the block
      // above leaves in place), alongside quotes, so no phrase carries a stray bracket.
      v = parts.map(s => s.trim().replace(/^[["']|[\]"']$/g, '')).filter(Boolean);
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
     source_commit,created,last_used,last_validated,access_count,body,path,scope,trust,triggers,polarity,superseded_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const seen = [];
  let n = 0;
  const ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/;
  for (const p of walkNotes()) {
    const raw = readFileSync(p, 'utf8');
    // A duplicated frontmatter key surviving to disk (a pre-fix legacy file, a hand
    // edit, or a dropped file) must not silently re-enable the Q-pinning poisoning
    // trick just because it made it past the write-time gate once before.
    const dupKey = duplicateFrontmatterKey(raw);
    if (dupKey) { console.warn(`reindex: skipping ${p} (duplicate frontmatter key '${dupKey}')`); continue; }
    const note = parseNote(raw, p);
    // A malformed id is unusable as both a primary key and a date (note.id.slice(0,10)
    // becomes garbage `created`), which propagates NaN into recency/scoring; drop it
    // rather than let it shuffle unpredictably into a top-k slice.
    if (!note?.id || !ID_RE.test(note.id)) continue;
    const was = prior.get(note.id);
    const csv = x => Array.isArray(x) ? x.join(',') : (x ?? '');
    // triggers phrases can legitimately contain commas themselves (that's the whole
    // reason the frontmatter delimiter is ';' and not ','); rejoining with a bare
    // comma via csv() would make the phrase boundary unrecoverable for any future
    // reader of this column. ' | ' is the reserved join delimiter, made unambiguous
    // by replacing any literal ' | ' a phrase happens to contain with ' / ' before
    // joining (parseNote does not forbid '|' inside a phrase, so we sanitize here).
    const phraseCsv = x => Array.isArray(x) ? x.map(s => String(s).split(' | ').join(' / ')).join(' | ') : (x ?? '');
    // q_value is untrusted file content (hand-edited or dropped in): clamp to the
    // configured range so a raw number cannot escape the utility-bypass threshold.
    // A missing/blank field (parseNote yields null) must fall through to the neutral
    // default, not get coerced by Number(null)===0 and clamped to the floor instead.
    const qRaw = note.q_value == null ? NaN : Number(note.q_value);
    const q = Number.isFinite(qRaw) ? Math.max(CONFIG.q_clamp[0], Math.min(CONFIG.q_clamp[1], qRaw)) : 0.5;
    // trust:user-explicit is a pinning credential (bypasses the similarity floor and
    // rides into every session). Read as-is, with no path restriction: an earlier
    // version of this gate restricted it to notes/personal/, which broke a real,
    // legitimately hand-stamped preference note living elsewhere. If a prompt-injected
    // transcript gets the reflector to emit its own trust: line, worker.mjs's
    // provenance stamp is inserted into the SAME frontmatter block (not appended
    // after it), producing a genuine duplicate key; the duplicateFrontmatterKey
    // check just above this line (not last-key-wins parsing) is what actually drops
    // that note before it ever reaches this function. The only sources of a single,
    // unduplicated trust:user-explicit line are rememberNote (hardcoded, safe) and a
    // deliberate hand-edit by the vault's owner, who can edit any file in their own
    // vault regardless of what this gate does.
    const trust = note.trust ?? 'unknown';
    // polarity is presentation framing (guidance vs pitfall); anything but the two
    // known values falls back to guidance so a malformed field can't hide a note.
    const polarity = note.polarity === 'pitfall' ? 'pitfall' : 'guidance';
    // access_count is DB-tracked telemetry (hooks bump it, files never carry a live
    // value); prefer whichever is higher so a stale file default cannot roll it back.
    const accessRaw = Number(note.access_count ?? 0);
    const access = Math.max(Number.isFinite(accessRaw) ? accessRaw : 0, was?.access_count ?? 0);
    up.run(note.id, note.title ?? '', note.type ?? '', note.status ?? 'active',
      note.confidence ?? 'med', q, csv(note.repos),
      csv(note.entities), csv(note.files), csv(note.links), note.source_commit ?? '',
      note.id.slice(0, 10), note.last_used ?? was?.last_used ?? null, note.last_validated ?? null,
      access, note.body ?? '', p, note.scope ?? 'shared', trust, phraseCsv(note.triggers), polarity,
      note.superseded_by ?? '');
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
      db.exec('CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, title, entities, repos, files, body, triggers);');
      db.prepare("INSERT INTO notes_fts SELECT id,title,entities,repos,files,body,triggers FROM notes WHERE status != 'archived'").run();
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
  const rows = db.prepare("SELECT title,entities,repos,files,body,triggers FROM notes WHERE status != 'archived'").all();
  const docs = rows.map(r => new Set(tokenize([r.title, r.entities, r.repos, r.files, r.body, r.triggers].join(' '))));
  return new Map(terms.map(t => [t, docs.filter(s => s.has(t)).length]));
}

// Stopwords: common English words carry no retrieval signal but match every note
// via the FTS OR-query, letting weakly-relevant notes pass the floor on chatty prompts.
const STOP = new Set(('the and for with that this have what was are you our all can how its not but now see use when why where which them they then than there here from will your know only also more some other into over after before again based make made need want just like been being were does doing done should could would about them very much still').split(' '));
export const tokenize = s =>
  [...new Set(String(s).toLowerCase().split(/[^a-z0-9@]+/).filter(w => w.length > 2 && !STOP.has(w)))];

// superseded: the arbiter judged another note to have replaced this one. Demoted, not
// deleted (0.2 costs ~0.12 of score, far more than any plausible Q edge), because a
// single cheap-model verdict must never destroy real knowledge: same reasoning as the
// two-strike rule on stale-verification. Git is the undo. The note stays retrievable
// and stays FTS-indexed, so if it is still the best answer to something it can win,
// but it can no longer outrank the note that corrected it.
const VALIDITY = { active: 1.0, 'needs-review': 0.4, superseded: 0.2, archived: 0 };

// bm25() weight args map positionally to notes_fts's full column list, INCLUDING the
// UNINDEXED id column (verified empirically: a 0 there is inert, it just keeps the
// arg count matching table column count). Order: id, title, entities, repos, files,
// body, triggers. triggers is weighted highest: it holds short SITUATION phrases in
// the user's own words (Memento-style trigger-keyed retrieval), which is a stronger
// match signal for "have I hit this before" than overlap with the solution's prose.
export const FTS_WEIGHTS = [0, 1.5, 1, 1, 1, 1, 2.5];
// Dedupe (consolidate.mjs) asks a different question than retrieval: "do these two
// notes describe the same underlying fact/fix", not "does the same kind of situation
// trigger both". Two unrelated notes can easily share a generic trigger phrase
// ("when tests hang") without being duplicates, so triggers is excluded (weight 0)
// here, unlike FTS_WEIGHTS above where it is deliberately boosted.
export const DEDUPE_FTS_WEIGHTS = [0, 1, 1, 1, 1, 1, 0];

// FTS5/BM25 similarity per note id, normalized 0..1 (1 = best match). {} when FTS5
// is unavailable or on failure, which makes scoreNotes fall back to keyword overlap.
function ftsSim(db, queryTerms) {
  if (!FTS5_OK) return {};
  try {
    const match = queryTerms.map(t => `"${t.replace(/"/g, '')}"`).join(' OR ');
    if (!match) return {};
    const rows = db.prepare(`SELECT id, bm25(notes_fts, ${FTS_WEIGHTS.join(',')}) r FROM notes_fts WHERE notes_fts MATCH ?`).all(match);
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
      const terms = tokenize([n.title, n.entities, n.repos, n.files, n.body, n.triggers].join(' '));
      sim = Math.min(1, terms.filter(t => q.has(t)).length / Math.sqrt((q.size || 1) * (terms.length || 1)) * 6);
    }
    sim ??= 0;
    const ref = new Date(n.last_used || n.created || now);
    const ageDays = Math.max(0, (now - ref) / 86400000);
    const recency = Math.exp(-ageDays * Math.LN2 / CONFIG.recency_half_life_days);
    const score = w.sim * sim + w.q * n.q_value + w.recency * recency + w.validity * validity;
    // raw (pre-weight) components exposed so the hooks can log them per injection;
    // tune-weights.mjs replays those logs under candidate weight vectors offline.
    return { ...n, score, sim, recency, validity };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, k);
}

// Follow supersede pointers on a ranked list: serve the WINNER's content in the loser's slot.
//
// Demotion alone provably cannot fix this. The superseded note is usually the strongest
// lexical match for the very query that surfaces it (it was written about exactly that
// symptom), so it keeps rank 1 on similarity no matter what validity says: measured on the
// live vault, the stale render-script note scores 0.775 against its own replacement's 0.634,
// and validity's ENTIRE normalized weight is 0.15, so even validity=0 only reaches 0.745.
// Demoting it harder would just make retrieval worse without ever flipping the pair.
//
// So treat the loser as what it actually is: a good retrieval KEY carrying stale CONTENT.
// Keep the key, swap the content. The winner inherits the loser's score (it earned that slot)
// and is marked `redirected_from` so the caller can be honest about what happened. If the
// winner is gone or archived, keep the loser: a flagged stale note beats silently dropping
// the only answer we have.
export function resolveSupersessions(db, notes, maxHops = 4) {
  const out = [], byId = new Map();
  for (const n of notes) {
    let cur = n, hops = 0;
    const chain = new Set([n.id]); // cycle guard: a mutual supersede pair must not loop
    while (cur.status === 'superseded' && cur.superseded_by && hops++ < maxHops) {
      const next = db.prepare('SELECT * FROM notes WHERE id=?').get(cur.superseded_by);
      if (!next || next.status === 'archived' || chain.has(next.id)) break;
      chain.add(next.id);
      cur = { ...next, score: n.score, sim: n.sim, recency: n.recency, validity: n.validity, redirected_from: cur.id };
    }
    // dedupe: the winner may already be on the list on its own merit (near-duplicates match
    // the same query), in which case the redirect collapses into it rather than doubling it.
    const seen = byId.get(cur.id);
    if (seen) { if (cur.score > seen.score) Object.assign(seen, cur); continue; }
    byId.set(cur.id, cur);
    out.push(cur);
  }
  return out;
}

// Adaptive-k: cut a scored, descending-sorted list at its largest RELATIVE score drop
// instead of always padding to k. A clear "cliff" means the notes past it are much
// weaker and only dilute attention (and pick up unfair r=0 judgments); when scores
// taper smoothly there is no cliff and the full k is kept. Always keeps >= 1.
export function adaptiveCut(scored, maxK = scored.length) {
  const list = scored.slice(0, maxK);
  if (list.length <= 1) return list;
  let cut = list.length, bestDrop = 0;
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1].score, cur = list[i].score;
    const drop = prev > 0 ? (prev - cur) / prev : 0; // relative gap
    if (drop > bestDrop && drop >= 0.5) { bestDrop = drop; cut = i; } // >=50% cliff only
  }
  return list.slice(0, cut);
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
  // BOM-tolerant, matching parseNote: a note edited by a BOM-writing tool (Notepad,
  // PowerShell -Encoding utf8) must stay manageable, else every future Q/status
  // update silently no-ops while callers log the change as if it happened.
  const fmMatch = /^(﻿?---\r?\n)([\s\S]*?)(\r?\n---)/.exec(before);
  if (!fmMatch) return null;
  let fm = fmMatch[2];
  for (const [key, val] of Object.entries(changes)) {
    const re = new RegExp(`^${key}:.*$`, 'm');
    // replacer FUNCTION: a value containing $&, $' etc. must not expand as a replacement pattern
    fm = re.test(fm) ? fm.replace(re, () => `${key}: ${val}`) : fm + `\n${key}: ${val}`;
  }
  const fmStart = fmMatch.index + fmMatch[1].length;
  const after = before.slice(0, fmStart) + fm + before.slice(fmStart + fmMatch[2].length);
  // tmp + rename: a concurrent reindex must never observe a truncated file mid-write.
  // The tmp name must be unique per writer: worker.mjs's --watch daemon and
  // consolidate.mjs's nightly job can both call updateNoteFile around the same time,
  // and a fixed `${path}.tmp` would let them race on the same tmp file, throwing
  // ENOENT on the loser's renameSync once the winner's rename already consumed it.
  const tmp = `${row.path}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, after);
  renameSync(tmp, row.path);
  const cols = ['status', 'q_value', 'last_used', 'last_validated', 'access_count', 'confidence', 'superseded_by'];
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

// Notes are git-committed and pushed, so a secret that reaches a note body is a secret that
// reaches the remote. The original list caught OpenAI, AWS, classic-GitHub and Slack keys plus
// an inline `password=`, and missed the four shapes a 2026 transcript actually carries: Google
// keys (AIza), JWTs (the `eyJ` header is base64 for `{"`), bearer tokens, and DB URLs with
// inline credentials. gh[pousr]_ generalizes the ghp_-only branch to the whole GitHub token
// family, and github_pat_ covers the fine-grained tokens that replaced it.
//
// Each new branch is bounded so it cannot eat legitimate note content: the credentialed-URL
// branch requires a full user:pass@host triple with a secret of 6+ chars, so
// `postgres://localhost:5432/app` and `https://github.com/kirti34n/unified-mem` stay clean;
// the bearer branch requires 24+ token characters, so `Authorization: Bearer $TOKEN` (a
// placeholder worth keeping in a note) survives. Measured on the live corpus: 12 of 12 secret
// shapes caught, 0 false positives across all 55 notes plus every entity hub, repo card,
// README and PLAN.
export const SECRET_RE = /(sk-[a-zA-Z0-9]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{22,}|xox[baprs]-[a-zA-Z0-9-]+|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|\bbearer\s+[a-zA-Z0-9._~+/-]{24,}={0,2}|\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]{6,}@[^\s/]+|password\s*[:=]\s*\S+|api[_-]?key\s*[:=]\s*['"][^'"]{12,})/i;

// Prompt-injection reject filter for the memory boundary (ported from TencentDB-Agent-Memory's
// looksLikePromptInjection, src/utils/sanitize.ts:180-221). Their framing is exactly right: a
// note is not passive data, it is text this system PUSHES into a future session's context
// unasked, so the vault is a stored-XSS surface. A transcript can be poisoned by anything the
// agent merely READ (a hostile README, an issue body, a web page), the reflector distills that
// into a note, and the note is replayed into every future session it matches. The existing gates
// do not cover this: validateNote checks SHAPE, the reflector type allow-list stops a poisoned
// note becoming a pinned preference, and duplicateFrontmatterKey stops Q/trust poisoning, but
// none of them read the note's prose.
//
// Deliberately NOT a faithful port. Three of their patterns are false-positive mines in a vault
// whose whole subject is running commands, and a false positive here silently destroys a note
// the user already paid a sonnet call to produce:
//   1. their /\b(run|execute|call|invoke)\b.{0,40}\b(tool|command|function|shell)\b/ fires on 2
//      of the 55 real notes in this vault ("Run the project's health-check command", "run every
//      documented command"). Dropped outright: a ~4% destruction rate for near-zero security
//      value, since "run the command" IS the knowledge this vault exists to store.
//   2. their bare `ignore .{0,30} (instructions|rules)` rejects "Do not ignore the lint rules"
//      and `forget .{0,30} context` rejects "Forget the old context manager pattern". Tightened
//      to require an AUTHORITY qualifier (previous/prior/above/all/your) between the verb and
//      its object, which is what separates an override attempt from ordinary technical English.
//   3. their tag list includes `tool` and `function`, which collide with `Array<function>` and a
//      note about an XML `<tool>` element. Narrowed to the boundary tags that can actually break
//      out of a pushed context block, and anchored on a closing '>'.
// Measured: 0 false positives across 215 real technical docs (55 notes, 148 entity hubs, repo
// cards, README, PLAN), 16 of 16 known attack strings caught, 0 of 16 benign coding sentences
// rejected.
const INJECTION_RE = [
  // instruction override: the verb alone is ordinary English, the authority qualifier is not
  /\b(ignore|disregard|forget)\b[^.]{0,30}\b(previous|prior|above|earlier|all|any|your)\b[^.]{0,20}\b(instruction|rule|guideline|context|prompt)s?\b/i,
  /\boverride\b[^.]{0,30}\b(previous|prior|above|all|your|safety|system)\b[^.]{0,20}\b(instruction|rule|guideline|prompt)s?\b/i,
  // role hijack. The lookahead keeps the ordinary continuations a note might use
  // ("you are now able to run the tests offline") out of the net.
  /\byou are now\b(?! going| about| ready| able)/i,
  /\bact as\b[^.]{0,20}\b(root|admin|dan|unrestricted|unfiltered|jailbroken)\b/i,
  /\b(enter|switch to|activate)\b[^.]{0,20}\b(dan|jailbreak|god|sudo|developer|debug|unrestricted|unfiltered)\s+mode\b/i,
  // system-boundary probing
  /\b(show|reveal|print|output|display|repeat|leak|dump|give)\b[^.]{0,20}\b(me\s+)?(your|the)\s+system prompt\b/i,
  /\breveal\b[^.]{0,20}\b(your|the)\s*(system|hidden|secret|internal)\s+(prompt|instruction|rule)s?\b/i,
  /\bwhat (are|is)\b[^.]{0,20}\byour\s+(system|hidden|original|initial)\s+(prompt|instruction|rule)s?\b/i,
  // context-boundary breakout: a note body carrying one of these closes the block it is
  // rendered inside, and everything after it reads to the model as host-level framing rather
  // than as note content.
  /<\s*\/?\s*(system|assistant|human|developer|system-reminder|relevant-memories)\s*>/i,
  // Chinese variants, kept from the source: an English-only filter is one any attacker bypasses
  // by switching language, and none of these collide with code or technical prose.
  /忽略(?:所有|之前|以上|先前)?(?:的)?(?:指令|规则|指示|说明)/,
  /无视(?:所有|之前|以上)?(?:的)?(?:指令|规则|限制)/,
  /(?:显示|输出|告诉我|给我看)(?:你的)?(?:系统|初始|隐藏)?(?:提示词|指令|规则)/,
  /你(?:现在|从现在开始)是/,
];
// Whitespace is normalized first so padding and newlines between keywords cannot split a phrase
// the patterns match ("ignore  all\n previous   instructions"). The bounded [^.] gaps keep every
// match inside a single sentence, so two innocent adjacent sentences cannot be stitched into a
// false hit across the full stop between them.
export function looksLikePromptInjection(text) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return INJECTION_RE.some(re => re.test(normalized));
}

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

// Transcript projection (D6). ONE pass over the .jsonl yields TWO strings, and the split is
// load-bearing, not tidiness:
//   .lean     prose only, byte-for-byte what worker.mjs has always built. The ONLY string the
//             reward path (detectOutcome + scoreSession) is ever allowed to see.
//   .enriched the same prose PLUS the commands that ran and the code the edits installed.
//             Handed ONLY to the reflector.
// They cannot be one string. detectOutcome reads a fixed text.slice(-8000) window and
// scoreSession's Q update keys off its verdict, so enriching that input re-weights the window:
// measured over the 321 real transcripts, feeding the enriched text to detectOutcome silently
// re-labels 11 sessions (7 indeterminate to success, 2 success to indeterminate, 1 success to
// failure, 1 indeterminate to failure). Q is cumulative and irreversible, and the same pinning
// argument the contribution judge already makes (change the input and the scores stop being
// comparable across time) applies here. So capture gets richer for the reflector while the
// reward channel does not move a single byte.
//
// Why every physical line carries its own tag, tool_use lines included: scoreSession's
// contribution matcher filters on lines starting "[assistant]", so one prefix on a multi-line
// message would hide every line after the first from Q scoring. The call lines need the same
// treatment for a different reason: reflect() strips them from its dedup query with a
// startsWith('[call:') filter, and a bare continuation line (a multi-line PowerShell heredoc,
// an edit hunk) would slip through and put escaped Windows paths back into that query.
const CALL_CMD_MAX = 1200; // Bash p90 1098, PowerShell p90 775: for a command the head carries the executable and the flags.
const CALL_NEW_MAX = 2000; // Edit new_string p90 1626: the fix IS the whole hunk, so it gets the bigger budget.
const clipHead = (s, n) => s.length > n ? s.slice(0, n) + `\n[...+${s.length - n} chars]` : s;
// Middle-out, NOT head-only. A stack trace's head is framework frames and a test run's head is
// collection output: the assertion and the exit status are at the TAIL. Measured, head-400 keeps
// 20.3% of tool_result bytes and keeps the wrong half; head-300 plus tail-500 keeps 29.7% and
// keeps both ends.
const clipEnds = (s, head, tail) => s.length > head + tail
  ? s.slice(0, head) + `\n[...${s.length - head - tail} chars elided...]\n` + s.slice(-tail) : s;

// Field-aware ALLOW-LIST, by tool name and by field. Deliberately NOT JSON.stringify(input):
// (a) measured, the "new_string" key begins at or after char 300 in 55.3% of real Edit calls
// (median offset 324), so a head slice of the serialized input keeps old_string, the BROKEN
// code, and truncates away the fix, which is the one thing a recovery note exists to record;
// (b) Write carries the entire file in input.content, so it contributes a path and nothing else;
// (c) an unknown tool (Agent, WebFetch, AskUserQuestion) would splice attacker-reachable free
// text straight into the reflector prompt, so unknown tools emit nothing at all.
function toolUseLines(c) {
  const i = c.input || {};
  switch (c.name) {
    case 'Bash': case 'PowerShell':
      return i.command ? [[`call:${c.name}`, clipHead(String(i.command), CALL_CMD_MAX)]] : [];
    case 'Edit': {
      const out = [];
      if (i.file_path) out.push(['call:Edit', String(i.file_path)]);
      // "+ " marks the installed code, so the reflector can tell the path line from the hunk and
      // quote the fix verbatim instead of paraphrasing the assistant's narration of it.
      if (i.new_string) out.push(['call:Edit',
        clipHead(String(i.new_string), CALL_NEW_MAX).split('\n').map(l => `+ ${l}`).join('\n')]);
      return out;
    }
    case 'Write': return i.file_path ? [['call:Write', String(i.file_path)]] : [];
    case 'Read': return i.file_path ? [['call:Read', String(i.file_path)]] : [];
    case 'Glob': return i.pattern ? [['call:Glob', `${i.pattern} ${i.path ?? ''}`.trim()]] : [];
    case 'Grep': return i.pattern ? [['call:Grep', `${i.pattern} ${i.path ?? i.glob ?? ''}`.trim()]] : [];
    default: return [];
  }
}

export function buildTranscripts(path, maxChars = 60_000) {
  if (!path || !existsSync(path)) return { lean: '', enriched: '' };
  const lean = [], rich = [];
  const push = (arr, role, text) => { for (const l of String(text).split('\n')) arr.push(`[${role}] ${l}`); };
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    try {
      const j = JSON.parse(line);
      const msg = j.message ?? j;
      const role = msg.role || j.type || '';
      const content = msg.content;
      if (typeof content === 'string') { push(lean, role, content); push(rich, role, content); }
      else if (Array.isArray(content)) for (const c of content) {
        if (c.type === 'text') { push(lean, role, c.text); push(rich, role, c.text); }
        if (c.type === 'tool_use') for (const [tag, body] of toolUseLines(c)) push(rich, tag, body);
        if (c.type === 'tool_result' && typeof c.content === 'string') {
          lean.push(`[tool] ${c.content.slice(0, 400)}`);        // FROZEN: this is the reward channel's input
          rich.push(`[tool] ${clipEnds(c.content, 300, 500)}`);
        }
      }
    } catch { /* skip non-JSON lines */ }
  }
  // Middle-out truncation, applied per string. 22.1% of real transcripts exceed 60k, so this is
  // a hot path and not a guard, and the TAIL must survive because detectOutcome only reads the
  // last 8k. maxChars stays at 60k: enrichment costs 1.023x corpus-wide, so raising the cap
  // would buy nothing and bill for it.
  const cap = s => s.length > maxChars ? s.slice(0, maxChars / 2) + '\n[...truncated...]\n' + s.slice(-maxChars / 2) : s;
  return { lean: cap(lean.join('\n')), enriched: cap(rich.join('\n')) };
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
  const notePath = join(dir, `${id}.md`);
  const tmp = `${notePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, note);
  renameSync(tmp, notePath);
  reindexNotes(db);
  return id;
}

// ---- LLM pipeline calls: one path, budget-guarded, cost-ledgered ----
// Monthly rotation: todaySpendUsd only ever needs the current month's entries, so a
// bounded file keeps every call's read-and-parse cheap instead of growing forever.
const ledgerPath = () => join(VAULT, 'index', `cost-ledger-${new Date().toISOString().slice(0, 7)}.jsonl`);

export function todaySpendUsd() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    return readFileSync(ledgerPath(), 'utf8').split('\n').filter(Boolean)
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
    appendFileSync(ledgerPath(), JSON.stringify({ ts: new Date().toISOString(), kind, model, usd }) + '\n');
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
