// Offline retrieval-weight fitting (Memento-inspired: log every injection with its
// component scores, then fit the ranking weights to the outcomes rather than guessing).
// Reads logged injections that carry component scores (sim/qv/rec/val, populated by the
// hooks) plus their judged contribution from q_history, and grid-searches the four
// weights to maximize same-session pairwise ranking concordance (a helped note should
// score above a not-helped note injected in the same session). Prints a recommendation;
// --apply writes the normalized weights into config.json.
//   node scripts/tune-weights.mjs [--apply] [--min-pairs N]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb, loadConfig, CONFIG_PATH } from './vault.mjs';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const MIN_PAIRS = argv.includes('--min-pairs') ? Number(argv[argv.indexOf('--min-pairs') + 1]) : 30;
const HELP_THRESHOLD = 0.5; // judged contribution > this = "helped"

const db = openDb();

// One labeled example per injection that has BOTH logged components and a judged
// contribution. helped = the judge scored this note's contribution above the threshold.
const rows = db.prepare(`
  SELECT i.session_id AS sid, i.sim AS sim, i.qv AS qv, i.rec AS rec, i.val AS val,
         MAX(h.contribution) AS contribution
  FROM injections i
  JOIN q_history h ON h.session_id = i.session_id AND h.note_id = i.note_id AND h.op = 'score'
  WHERE i.demo = 0 AND i.sim IS NOT NULL AND i.qv IS NOT NULL AND i.rec IS NOT NULL AND i.val IS NOT NULL
    AND h.contribution IS NOT NULL
  GROUP BY i.session_id, i.note_id
`).all().map(r => ({ ...r, helped: r.contribution > HELP_THRESHOLD }));

// Build same-session (helped, not-helped) pairs: the only pairs whose relative ranking
// the weights can be judged against (cross-session comparison is not meaningful).
const bySession = {};
for (const r of rows) (bySession[r.sid] ??= []).push(r);
const pairs = [];
for (const list of Object.values(bySession)) {
  const helped = list.filter(r => r.helped), not = list.filter(r => !r.helped);
  for (const h of helped) for (const n of not) pairs.push([h, n]);
}

if (pairs.length < MIN_PAIRS) {
  console.error(`insufficient data: ${pairs.length} labeled helped/not-helped pairs (< ${MIN_PAIRS}). ` +
    `Weight fitting needs more injection history with component scores AND judged outcomes. ` +
    `Keep using the vault; component logging is forward-only, so this becomes usable as sessions accumulate.`);
  process.exit(1);
}

const scoreOf = (w, r) => w.sim * r.sim + w.q * r.qv + w.recency * r.rec + w.validity * r.val;
// concordance = fraction of same-session helped/not-helped pairs the weights rank correctly
const concordance = w => {
  let ok = 0;
  for (const [h, n] of pairs) if (scoreOf(w, h) > scoreOf(w, n)) ok++;
  return ok / pairs.length;
};
const norm = ([s, q, r, v]) => { const t = s + q + r + v || 1; return { sim: s / t, q: q / t, recency: r / t, validity: v / t }; };

// Coarse grid over the 4-simplex (normalized), plus the current config as a baseline.
// EVERY step is >= 0.1: no component may be zeroed. This is a hard prior, not a tuning
// artifact. The concordance objective ranks helped-vs-not WITHIN a session's already
// sim-floor-passing set, where sim barely discriminates (it was pre-gated) while q
// correlates with the judged label (Q is trained on the same outcomes), so an
// unconstrained fit collapses to sim=0 and ranks purely by Q, discarding query
// relevance for every real retrieval. Similarity is the relevance signal and must
// always carry weight; the floor keeps the fit on the simplex interior.
const cur = norm([loadConfig().weights.sim, loadConfig().weights.q, loadConfig().weights.recency, loadConfig().weights.validity].map(x => x));
const steps = [0.1, 0.2, 0.3, 0.4, 0.5];
let best = { w: cur, c: concordance(cur) };
for (const s of steps) for (const q of steps) for (const r of steps) for (const v of steps) {
  const w = norm([s, q, r, v]);
  const c = concordance(w);
  if (c > best.c + 1e-9) best = { w, c };
}

const pct = x => (x * 100).toFixed(1) + '%';
console.log(`labeled pairs: ${pairs.length} (from ${rows.length} judged injections across ${Object.keys(bySession).length} sessions)`);
console.log(`current weights concordance: ${pct(concordance(cur))}  (${JSON.stringify(round(cur))})`);
console.log(`best-found concordance:      ${pct(best.c)}  (${JSON.stringify(round(best.w))})`);

if (best.c <= concordance(cur) + 0.01) {
  console.log('current weights are within 1 point of the best found: no change recommended.');
  process.exit(0);
}
if (APPLY) {
  const cfg = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
  cfg.weights = round(best.w);
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`applied fitted weights to ${CONFIG_PATH}`);
} else {
  console.log('re-run with --apply to write these weights into config.json.');
}

function round(w) { return { sim: +w.sim.toFixed(3), q: +w.q.toFixed(3), recency: +w.recency.toFixed(3), validity: +w.validity.toFixed(3) }; }
