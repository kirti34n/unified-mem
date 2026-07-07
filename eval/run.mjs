// A/B eval harness (R11): same questions via headless `claude -p`,
// arm A = memory injected by SessionStart hook, arm B = MEMORY_OFF=1 control.
// CLI:  node eval/run.mjs [--runs N] [--arms A,B] [--questions N] [--model m]
// Also importable: runEval(opts) → results (used by scripts/improve.mjs).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CONFIG, ROOT, VAULT, openDb, todaySpendUsd, appendLedger } from '../scripts/vault.mjs';

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
// true median: mean of the two middle values for even n (was biased high)
const median = a => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// A model that declares ignorance and then guesses a generic pattern must NOT be
// graded correct just because the guess happens to match the expect regex: that
// inflates the score with non-answers. Skipped for negative probes, where "I don't
// know / we never discussed it" IS the correct answer.
const IDK_RE = /\b(i (don'?t|do not) know|not (sure|aware|certain)|no (idea|record|memory|information|notes?) (of|about|on|that)|without (seeing|checking|reading|investigating|looking)|haven'?t (seen|explored|looked)|i'?d need to (see|look|check|read|investigate))\b/i;

// Pure grader (exported for unit tests): the load-bearing fact must appear, AND
// (unless this is a negative probe) the answer must not be a hedged non-answer.
export function grade(out, expect, negative = false) {
  const matched = new RegExp(expect, 'i').test(out);
  return matched && (negative ? true : !IDK_RE.test(out));
}

// Default question set: the REAL one when it exists. questions.json is demo data
// wired to fictional seed notes; measuring against it is circular and only allowed
// via an explicit --demo flag.
export function defaultQuestionFile(demo = false) {
  const real = join(EVAL_DIR, 'questions.real.json');
  return (!demo && existsSync(real)) ? real : join(EVAL_DIR, 'questions.json');
}

export function runEval({ runs = 1, arms = ['A', 'B'], questions = Infinity, model = CONFIG.eval_model, quiet = false, file = null, demo = false } = {}) {
  const qfile = file || defaultQuestionFile(demo);
  if (!file && qfile.endsWith('questions.json') && !quiet)
    console.warn('[eval] using DEMO questions (fictional seed data): results demonstrate the pipeline works, not real-world value. Add eval/questions.real.json for a real measurement.');
  const qs = JSON.parse(readFileSync(qfile, 'utf8')).slice(0, questions);
  // Arm-A preflight: if the retriever injects nothing while the vault has notes,
  // memory is not actually active and arm A would silently equal arm B: every
  // number the eval produces would be a lie. Abort loudly instead.
  if (arms.includes('A')) {
    const hasNotes = openDb().prepare("SELECT COUNT(*) c FROM notes WHERE status != 'archived'").get().c > 0;
    if (hasNotes) {
      const pre = spawnSync(process.execPath, [join(ROOT, 'scripts', 'retrieve.mjs')], {
        input: JSON.stringify({ session_id: 'eval-preflight', cwd: ROOT }),
        encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, UNIFIED_MEM_NO_CAPTURE: '1' },
      });
      if (!String(pre.stdout).includes('MEMORY CATALOG'))
        throw new Error('eval preflight failed: retrieve.mjs produced no output while the vault has notes; hooks/memory are not active, arm A would silently equal arm B');
    }
  }
  const rows = [];
  outer: for (const q of qs) for (const arm of arms) for (let r = 0; r < runs; r++) {
    // budget guard: eval is a real pipeline cost, so it respects the same daily cap
    // as every other LLM call and stops rather than silently overspending
    if (todaySpendUsd() >= CONFIG.daily_budget_usd) {
      console.warn(`[budget] daily cap $${CONFIG.daily_budget_usd} reached, stopping eval early (${rows.length} samples collected)`);
      break outer;
    }
    const t0 = Date.now();
    // per-question cwd: the control arm gets a FAIR shot at re-deriving the answer
    // from the repo itself, so the comparison measures memory vs re-discovery
    const cwd = q.cwd && existsSync(q.cwd) ? q.cwd : ROOT;
    const res = spawnSync(`claude -p --model ${model} --output-format json --strict-mcp-config`, {
      input: q.q, encoding: 'utf8', shell: true, cwd, timeout: 240_000,
      // NO_CAPTURE: eval sessions must not be enqueued for reflection (cost + noise)
      env: { ...process.env, UNIFIED_MEM_NO_CAPTURE: '1', ...(arm === 'B' ? { MEMORY_OFF: '1' } : {}) },
    });
    // --output-format json gives us both the answer text and the true cost for the ledger
    let out = '', usd = 0;
    try { const j = JSON.parse(String(res.stdout || '')); out = String(j.result ?? ''); usd = j.total_cost_usd ?? 0; }
    catch { out = String(res.stdout || ''); }
    appendLedger('eval', model, usd);
    const row = {
      id: q.id, arm, run: r, ms: Date.now() - t0, chars: out.length, usd,
      // honest grading: the fact must appear AND (for non-probes) the answer must not
      // be a hedged "I don't know" that merely happens to contain the keyword
      correct: grade(out, q.expect, q.negative),
      out, // full text stored (results dir is gitignored) so grades can be re-audited
    };
    rows.push(row);
    if (!quiet) console.log(`  ${q.id} [${arm}] ${row.correct ? 'PASS' : 'fail'} ${row.ms}ms ${row.chars}ch`);
  }
  const summary = {};
  for (const arm of arms) {
    const a = rows.filter(r => r.arm === arm);
    summary[arm] = {
      n: a.length,
      correct: a.filter(r => r.correct).length,
      correct_rate: a.filter(r => r.correct).length / (a.length || 1),
      median_ms: median(a.map(r => r.ms)),
      median_chars: median(a.map(r => r.chars)),
    };
  }
  const spend_usd = rows.reduce((s, r) => s + (r.usd || 0), 0);
  return { ts: new Date().toISOString(), config_weights: CONFIG.weights, k: CONFIG.k, model, spend_usd, rows, summary };
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
  mkdirSync(join(VAULT, 'eval-results'), { recursive: true });
  const file = join(VAULT, 'eval-results', `${result.ts.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log('saved:', file);
}
