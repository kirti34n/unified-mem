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
import { join } from 'node:path';
import { ROOT, VAULT, loadConfig } from './vault.mjs';
import { runEval, defaultQuestionFile } from '../eval/run.mjs';

const argv = process.argv.slice(2);
const opt = (f, d) => argv.includes(f) ? argv[argv.indexOf(f) + 1] : d;
const FOREVER = argv.includes('--forever');
const ITER = FOREVER ? Infinity : Number(opt('--iterations', 5));
const qFile = opt('--file', defaultQuestionFile());
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
const CONFIG_PATH = join(ROOT, 'config.json');
const LOG_DIR = join(VAULT, 'improve');
mkdirSync(LOG_DIR, { recursive: true });
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
let bestScore = scoreOf(best.summary);
console.log(`baseline: correct ${(best.summary.A.correct_rate * 100).toFixed(0)}% · ${best.summary.A.median_chars}ch · ${best.summary.A.median_ms}ms · score ${bestScore.toFixed(1)}`);
log({ ts: new Date().toISOString(), phase: 'baseline', summary: best.summary, score: bestScore });

for (let i = 1; i <= ITER; i++) {
  if (existsSync(join(VAULT, 'STOP'))) { console.log('STOP file found, halting.'); break; }
  const cfg = loadConfig();
  const h = hypotheses(cfg).next().value;
  if (!h) { console.log('knob grid exhausted, halting. Add values to KNOBS in improve.mjs to continue.'); break; }
  tried.add(h.knob + '=' + h.value);

  console.log(`\n[${i}] HYPOTHESIS: ${h.knob}=${h.value} (was ${get(cfg, h.knob)}) improves retrieval`);
  const backup = readFileSync(CONFIG_PATH, 'utf8');
  set(cfg, h.knob, h.value);
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); // IMPLEMENT

  let verdict = 'error', summary = null, score = null;
  try {
    const r = runEval(evalOpts); // TEST (fresh claude -p sessions read the new config)
    summary = r.summary; score = scoreOf(summary);
    if (beats(summary, best.summary)) { verdict = 'accept'; best = r; bestScore = score; }
    else { verdict = 'revert'; writeFileSync(CONFIG_PATH, backup); }
  } catch (e) { writeFileSync(CONFIG_PATH, backup); console.error('  eval failed:', e.message); }
  console.log(`  TEST: correct ${summary ? (summary.A.correct_rate * 100).toFixed(0) + '%' : '?'} · score ${score?.toFixed(1) ?? '?'} vs best ${bestScore.toFixed(1)} → ${verdict.toUpperCase()}`);
  log({ ts: new Date().toISOString(), iter: i, knob: h.knob, value: h.value, summary, score, verdict });
}
console.log(`\ndone. best score ${bestScore.toFixed(1)} · winning config in config.json · full log in improve/log.jsonl`);
