// Free, deterministic, $0 retrieval eval. No LLM, no network, no spend.
//
// The paid eval (eval/run.mjs) only ever asks "when memory SHOULD fire, does it?". It cannot see
// the failure that actually degrades a session: memory firing when it should NOT. That failure is
// invisible precisely because it is silent, it would cost a paid call per probe to measure, and it
// is the one a retrieval change is most likely to regress. So it went unmeasured, and it rotted:
// the per-prompt gate was folding the cwd basename into the query, and since a repo name is by
// construction frequent in that repo's own notes yet still under the rarity cap, the folder name
// alone satisfied the gate for EVERY prompt. "what should we have for dinner" was injecting notes.
// This harness turns that from a surprise into a number.
//
// Both arms are measured together because they trade off. A gate tight enough to score zero false
// positives is trivial to write (abstain always) and worthless: recall has to survive it.
//
// Usage: node eval/negatives.mjs [--verbose]
// Exits 1 on regression, so it can gate a commit.
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb } from '../scripts/vault.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

// Ordinary human prompts with no technical content. None of these may retrieve anything, from any
// repo. They are deliberately long: the gate ignores prompts under 25 chars, so a short prompt
// would abstain for the wrong reason and prove nothing.
const OFF_TOPIC = [
  'what should we have for dinner tonight, any thoughts on that?',
  'can you tell me a joke about penguins please, something funny',
  'who won the football match yesterday evening in the league',
  'i am feeling tired today, maybe i should go to sleep early',
  'what is the weather going to be like this weekend outside',
  'tell me about the history of the roman empire in europe',
  'my cat keeps knocking things off the table, why does she do that',
  'recommend a good movie to watch on a rainy sunday afternoon',
  'how many people live in tokyo compared to delhi these days',
  'i want to learn how to play the guitar, where should i start',
  'what is your favourite colour and why do you like it so much',
  'explain the offside rule in football to someone who never watched',
  'is it better to run in the morning or the evening for fitness',
  'what should i cook for my friends who are coming over saturday',
  'do you think it will rain tomorrow or should i plan a picnic',
  'my plant leaves are turning yellow, am i watering it too much',
  'what are some good books to read during a long flight abroad',
  'how do i teach my dog to stop barking at the postman please',
  'which city has the best street food in the whole world really',
  'i cannot decide between the blue shirt or the green one today',
];

const db = openDb();
// Repos are read from the vault itself, plus names it has never seen. Firing every off-topic
// prompt from EVERY repo is the point: a cwd leak shows up as "this prompt injects in repo X but
// not repo Y", which no single-cwd probe can see. The unknown names catch an unfamiliar-repo leak.
const known = db.prepare("SELECT DISTINCT repos FROM notes WHERE status != 'archived' AND repos != ''")
  .all().flatMap(r => r.repos.split(',').map(s => s.trim())).filter(Boolean);
const REPOS = [...new Set([...known, 'some-unknown-repo', 'notes-app'])].slice(0, 16);

// The positive arm is derived from the vault's own notes: query each note with its own title and
// require that SOMETHING comes back. This is deliberately NOT a quality claim (grading notes with
// questions written from those same notes would be circular, which is the trap the eval questions
// themselves have to avoid). It is an index liveness check, and its only job is to make the
// "abstain on everything" degenerate solution fail loudly.
const titles = db.prepare("SELECT title FROM notes WHERE status='active' AND trust != 'demo' AND type != 'preference' AND length(title) > 30 ORDER BY id LIMIT 12")
  .all().map(r => r.title);

const cwdFor = repo => join(tmpdir(), repo); // the path need not exist: only its basename is read
const ask = (repo, prompt) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'retrieve-prompt.mjs')], {
  input: JSON.stringify({ session_id: `neg-${Math.random()}`, cwd: cwdFor(repo), prompt }),
  encoding: 'utf8',
  // NO_CAPTURE: read the retrieval path without mutating it. Without this the eval logs injections
  // and bumps access_count, i.e. the measurement trains the thing it is measuring.
  env: { ...process.env, UNIFIED_MEM_NO_CAPTURE: '1' },
}).stdout.trim();

let fp = 0, negTotal = 0;
const leaks = new Map();
for (const repo of REPOS) {
  for (const prompt of OFF_TOPIC) {
    negTotal++;
    if (ask(repo, prompt)) { fp++; leaks.set(prompt, (leaks.get(prompt) || 0) + 1); }
  }
}

let hits = 0;
const misses = [];
for (const t of titles) {
  if (ask(REPOS[0] || 'x', t)) hits++;
  else misses.push(t);
}

console.log(`negatives: ${fp}/${negTotal} false positives (${(100 * fp / negTotal).toFixed(1)}%)  [target 0]`);
console.log(titles.length
  ? `positives: ${hits}/${titles.length} notes retrievable by their own title   [target ${titles.length}]`
  : 'positives: skipped (vault has no eligible notes yet)');

for (const [prompt, n] of [...leaks].sort((a, b) => b[1] - a[1]))
  console.log(`  LEAK x${n}: "${prompt}"`);
if (VERBOSE) for (const m of misses) console.log(`  MISS: ${m}`);

// A prompt that leaks in EVERY repo tripped the gate on its own words. A prompt that leaks in only
// SOME repos means the cwd is bleeding into the query again, which is the specific regression this
// file exists to catch. Name the mechanism so the next reader does not have to rediscover it.
if (leaks.size && [...leaks.values()].some(n => n < REPOS.length))
  console.log('\n  ^ leaks vary BY REPO: the cwd is entering the query again (see retrieve-prompt.mjs)');

const ok = fp === 0 && (!titles.length || hits === titles.length);
console.log(ok ? '\nRETRIEVAL OK' : '\nRETRIEVAL REGRESSION');
process.exit(ok ? 0 : 1);
