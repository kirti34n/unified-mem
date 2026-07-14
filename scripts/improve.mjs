// Self-improvement loop: RESEARCH → HYPOTHESIS → IMPLEMENT → TEST → ACCEPT/REVERT → repeat.
// Hill-climbs the retrieval tunables in config.json against the A-arm eval score.
// Runs OUTSIDE any Claude Code session (plain node + headless `claude -p` calls),
// so no CLI session limit applies. It stops only when:
//   - iterations are exhausted (--iterations N, default 5; --forever to never stop), or
//   - a file named STOP exists in the vault root (create it to halt gracefully), or
//   - the knob grid is exhausted (every neighbor tried and rejected).
// Usage:  node scripts/improve.mjs [--iterations N | --forever] [--runs N] [--questions N] [--model m]
// Log:    improve/log.jsonl (one JSON line per iteration, hypothesis, scores, verdict)
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT, VAULT, CONFIG_PATH, loadConfig } from './vault.mjs';
import { runEval as paidRunEval, defaultQuestionFile } from '../eval/run.mjs';

// improve.mjs is the ONE script no test can run, because every iteration spends real money on
// `claude -p`. That is not a footnote, it is why a ReferenceError sat in its accept path
// undetected: `accepted` was used three times and declared nowhere, so an accepted knob threw,
// the surrounding try swallowed it as "eval failed" and rolled the knob back, and the final
// summary then threw again, uncaught. The loop had never once accepted a knob.
//
// UNIFIED_MEM_FAKE_EVAL=1 swaps the paid evaluator for a deterministic synthetic one, so the whole
// loop (baseline, hypothesis, accept, revert, config rollback, final summary) executes end to end
// for zero dollars and can be exercised by smoke.mjs. The real path is untouched: without the env
// var this is literally the same function it always was. The synthetic scores are rigged so the
// first hypothesis ACCEPTS and the second REVERTS, because a fake eval that only ever exercises
// the happy path would be the same kind of test that cannot fail.
const FAKE_EVAL = process.env.UNIFIED_MEM_FAKE_EVAL === '1';
let fakeCall = 0;
const runEval = FAKE_EVAL
  ? () => {
    const n = fakeCall++;
    // call 0 = baseline, 1 = a clear win (accept), 2+ = worse (revert)
    const correct_rate = n === 0 ? 0.70 : n === 1 ? 0.90 : 0.50;
    return { summary: { A: { n: 18, correct_rate, median_chars: 500, median_ms: 1000 } }, rows: [] };
  }
  : paidRunEval;

const argv = process.argv.slice(2);
const opt = (f, d) => argv.includes(f) ? argv[argv.indexOf(f) + 1] : d;
const FOREVER = argv.includes('--forever');
// DRY RUN BY DEFAULT. This loop rewrites the live config.json, and it has already shipped a bad
// write: iteration 2 accepted weights.sim 0.4 -> 0.5 on n=3, with BOTH arms at correct_rate 1.0,
// purely on a median-output-length tiebreak (501 characters to 416). That value was committed (9922166)
// and had to be reverted by hand (2d1b52a). Meanwhile three eval runs on the same day with an
// IDENTICAL config scored 100% / 93% / 83%: run-to-run noise is several times larger than the
// margin the loop accepts on. A process that mutates production config from a signal smaller
// than its own noise floor must not do so unattended, so an accepted knob is now REPORTED and
// then rolled back. Pass --apply to actually keep it.
const APPLY = argv.includes('--apply');
const ITER = FOREVER ? Infinity : Number(opt('--iterations', 5));
const qFile = opt('--file', defaultQuestionFile());
// The improve loop mutates PRODUCTION config, so it must never hill-climb against the
// fictional demo question set. defaultQuestionFile() silently falls back to the demo
// questions.json when no questions.real.json exists, and evalOpts.quiet suppresses
// eval/run.mjs's own demo warning, so guard here: refuse the demo set unless it was
// passed deliberately (--file, or --demo to acknowledge it).
if (!argv.includes('--file') && !argv.includes('--demo') && qFile.endsWith('questions.json')) {
  console.error('refusing to run: no eval/questions.real.json found, so this would tune production config against ' +
    'the FICTIONAL demo question set. Create eval/questions.real.json (see docs/EVAL.md) first, or pass --demo to override.');
  process.exit(1);
}
const evalOpts = {
  runs: Number(opt('--runs', 2)),
  questions: Number(opt('--questions', Infinity)),
  model: opt('--model', loadConfig().eval_model),
  arms: ['A'], quiet: true, file: qFile, // knob comparison only needs the memory arm
};

// Minimum-sample gate: a loop that mutates production config MUST NOT decide on
// jitter. Refuse to run below 14 A-arm samples per measurement.
{
  const { readFileSync } = await import('node:fs');
  const nq = Math.min(JSON.parse(readFileSync(qFile, 'utf8')).length, evalOpts.questions);
  if (nq * evalOpts.runs < 14) {
    console.error(`refusing to run: ${nq} questions x ${evalOpts.runs} runs = ${nq * evalOpts.runs} samples (< 14). ` +
      `Add questions to ${qFile} or raise --runs. Config changes decided on noise are worse than none.`);
    process.exit(1);
  }
}
const LOG_DIR = join(VAULT, 'improve');
mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(dirname(CONFIG_PATH), { recursive: true }); // ensure the config dir exists before we back it up / write it
const log = entry => appendFileSync(join(LOG_DIR, 'log.jsonl'), JSON.stringify(entry) + '\n');

// Knob grid: one-change-at-a-time neighbors of the current config (hill climbing).
const KNOBS = [
  ['weights.sim', [0.30, 0.40, 0.50]],
  ['weights.q', [0.20, 0.30, 0.40]],
  ['k', [3, 5, 7]],
  ['recency_half_life_days', [15, 30, 60]],
  ['max_inject_chars', [6000, 10000, 14000]],
];
const get = (o, p) => p.split('.').reduce((x, k) => x[k], o);
const set = (o, p, v) => { const ks = p.split('.'); ks.slice(0, -1).reduce((x, k) => x[k], o)[ks.at(-1)] = v; };

// score: correctness first, then fewer output chars (cheaper), then faster
const scoreOf = s => s.A.correct_rate * 1000 - s.A.median_chars / 1000 - s.A.median_ms / 100000;
// noise guard: single-run char/latency jitter must not drive config changes.
// Accept only if correctness strictly improves, or ties with ≥15% fewer output chars.
const beats = (s, b) => s.A.correct_rate > b.A.correct_rate + 1e-9 ||
  (Math.abs(s.A.correct_rate - b.A.correct_rate) < 1e-9 && s.A.median_chars < b.A.median_chars * 0.85);

const tried = new Set();
try { for (const line of readFileSync(join(LOG_DIR, 'log.jsonl'), 'utf8').split('\n')) { const j = JSON.parse(line); if (j.knob) tried.add(j.knob + '=' + j.value); } } catch { }

function* hypotheses(cfg) {
  for (const [knob, values] of KNOBS) for (const v of values) {
    if (get(cfg, knob) === v) continue;
    if (tried.has(knob + '=' + v)) continue;
    yield { knob, value: v };
  }
}

console.log(`improve loop: ${FOREVER ? 'forever (create STOP file to halt)' : ITER + ' iterations'} · eval model ${evalOpts.model}`);
console.log('RESEARCH: measuring baseline with current config...');
let best = runEval(evalOpts);
// The pre-flight gate above checks the PLANNED sample count; the daily budget cap
// can still truncate the actual run mid-eval (eval/run.mjs's own budget guard).
// A config-mutating loop must never trust a baseline built from a truncated run.
if (best.summary.A.n < 14) {
  console.error(`refusing to trust baseline: only ${best.summary.A.n} actual A-arm samples collected (budget cap or spawn failures cut the run short). Raise daily_budget_usd or re-run after spend resets.`);
  process.exit(1);
}
let bestScore = scoreOf(best.summary);
// Knobs this run accepted, so the final summary can name them. It was USED in three places and
// DECLARED in none, which made the accept path throw a ReferenceError that the surrounding try
// swallowed as "eval failed" (rolling the knob back), and then throw again, uncaught, in the final
// summary. The loop had therefore never successfully accepted a knob in its life. Nothing caught it
// because improve.mjs makes paid `claude -p` calls, so it is the one script never run in a test.
const accepted = [];
console.log(`baseline: correct ${(best.summary.A.correct_rate * 100).toFixed(0)}% · ${best.summary.A.median_chars}ch · ${best.summary.A.median_ms}ms · score ${bestScore.toFixed(1)}`);
log({ ts: new Date().toISOString(), phase: 'baseline', summary: best.summary, score: bestScore });

for (let i = 1; i <= ITER; i++) {
  if (existsSync(join(VAULT, 'STOP'))) { console.log('STOP file found, halting.'); break; }
  const cfg = loadConfig();
  const h = hypotheses(cfg).next().value;
  if (!h) { console.log('knob grid exhausted, halting. Add values to KNOBS in improve.mjs to continue.'); break; }
  tried.add(h.knob + '=' + h.value);

  console.log(`\n[${i}] HYPOTHESIS: ${h.knob}=${h.value} (was ${get(cfg, h.knob)}) improves retrieval`);
  const backup = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf8') : JSON.stringify(cfg, null, 2);
  set(cfg, h.knob, h.value);
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); // IMPLEMENT

  let verdict = 'error', summary = null, score = null;
  try {
    const r = runEval(evalOpts); // TEST (fresh claude -p sessions read the new config)
    summary = r.summary; score = scoreOf(summary);
    // Actual, not planned: the budget cap can truncate THIS run too, and a lucky
    // single sample (or a 0/0 tie against a zero baseline) must never flip a knob.
    if (summary.A.n < 14) { verdict = 'insufficient-samples'; writeFileSync(CONFIG_PATH, backup); }
    // On accept the mutated config is what is already on disk, so keeping it means doing
    // nothing. That silence is exactly why the bad write shipped unnoticed, so the rollback is
    // explicit and the verdict says which happened.
    else if (beats(summary, best.summary)) {
      verdict = APPLY ? 'accept' : 'accept-dry-run';
      best = r; bestScore = score;
      accepted.push(`${h.knob}=${h.value}`);
      if (!APPLY) writeFileSync(CONFIG_PATH, backup);
    }
    else { verdict = 'revert'; writeFileSync(CONFIG_PATH, backup); }
  } catch (e) { writeFileSync(CONFIG_PATH, backup); console.error('  eval failed:', e.message); }
  console.log(`  TEST: correct ${summary ? (summary.A.correct_rate * 100).toFixed(0) + '%' : '?'} · n=${summary?.A.n ?? '?'} · score ${score?.toFixed(1) ?? '?'} vs best ${bestScore.toFixed(1)} → ${verdict.toUpperCase()}`);
  log({ ts: new Date().toISOString(), iter: i, knob: h.knob, value: h.value, summary, score, verdict });
}
const state = APPLY
  ? (accepted.length ? `wrote ${accepted.join(', ')} to ${CONFIG_PATH}`
                     : `no knob beat the baseline, ${CONFIG_PATH} holds the baseline config`)
  : (accepted.length ? `DRY RUN: ${CONFIG_PATH} holds the baseline config, NOT the accepted knob(s) ${accepted.join(', ')} (they were rolled back). Set one by hand to keep it: an --apply re-run will not re-propose it, because every knob tried is recorded in improve/log.jsonl and skipped from then on.`
                     : `DRY RUN: no knob beat the baseline, ${CONFIG_PATH} holds the baseline config`);
console.log(`\ndone. best score ${bestScore.toFixed(1)} · ${state} · full log in improve/log.jsonl`);
