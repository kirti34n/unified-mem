// A/B eval harness (R11): same questions via headless `claude -p`,
// arm A = memory injected by SessionStart hook, arm B = MEMORY_OFF=1 control.
// CLI:  node eval/run.mjs [--runs N] [--arms A,B] [--questions N] [--model m]
// Also importable: runEval(opts) → results (used by scripts/improve.mjs).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CONFIG, ROOT } from '../scripts/vault.mjs';

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const median = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];

// Default question set: the REAL one when it exists. questions.json is demo data
// wired to fictional seed notes; measuring against it is circular and only allowed
// via an explicit --demo flag.
export function defaultQuestionFile(demo = false) {
  const real = join(EVAL_DIR, 'questions.real.json');
  return (!demo && existsSync(real)) ? real : join(EVAL_DIR, 'questions.json');
}

export function runEval({ runs = 1, arms = ['A', 'B'], questions = Infinity, model = CONFIG.eval_model, quiet = false, file = null, demo = false } = {}) {
  const qs = JSON.parse(readFileSync(file || defaultQuestionFile(demo), 'utf8')).slice(0, questions);
  const rows = [];
  for (const q of qs) for (const arm of arms) for (let r = 0; r < runs; r++) {
    const t0 = Date.now();
    // per-question cwd: the control arm gets a FAIR shot at re-deriving the answer
    // from the repo itself, so the comparison measures memory vs re-discovery
    const cwd = q.cwd && existsSync(q.cwd) ? q.cwd : ROOT;
    const res = spawnSync(`claude -p --model ${model} --strict-mcp-config`, {
      input: q.q, encoding: 'utf8', shell: true, cwd, timeout: 240_000,
      // NO_CAPTURE: eval sessions must not be enqueued for reflection (cost + noise)
      env: { ...process.env, UNIFIED_MEM_NO_CAPTURE: '1', ...(arm === 'B' ? { MEMORY_OFF: '1' } : {}) },
    });
    const out = String(res.stdout || '');
    const row = {
      id: q.id, arm, run: r, ms: Date.now() - t0, chars: out.length,
      correct: new RegExp(q.expect, 'i').test(out), out: out.slice(0, 500),
    };
    rows.push(row);
    if (!quiet) console.log(`  ${q.id} [${arm}] ${row.correct ? 'PASS' : 'fail'} ${row.ms}ms ${row.chars}ch`);
  }
  const summary = {};
  for (const arm of arms) {
    const a = rows.filter(r => r.arm === arm);
    summary[arm] = {
      n: a.length,
      correct_rate: a.filter(r => r.correct).length / (a.length || 1),
      median_ms: median(a.map(r => r.ms)) ?? 0,
      median_chars: median(a.map(r => r.chars)) ?? 0,
    };
  }
  return { ts: new Date().toISOString(), config_weights: CONFIG.weights, k: CONFIG.k, model, rows, summary };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const argv = process.argv.slice(2);
  const opt = (f, d) => argv.includes(f) ? argv[argv.indexOf(f) + 1] : d;
  const result = runEval({
    runs: Number(opt('--runs', 1)),
    arms: opt('--arms', 'A,B').split(','),
    questions: Number(opt('--questions', Infinity)),
    model: opt('--model', CONFIG.eval_model),
    file: opt('--file', null),
    demo: argv.includes('--demo'),
  });
  console.log('\nsummary:', JSON.stringify(result.summary, null, 2));
  mkdirSync(join(EVAL_DIR, 'results'), { recursive: true });
  const file = join(EVAL_DIR, 'results', `${result.ts.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log('saved:', file);
}
