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
import { openDb, rarityGate, rareHits, tokenize } from '../scripts/vault.mjs';

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
// Repos the vault holds no note about. They are what let the session-start arm below actually FAIL,
// which is this file own standard: a green tick that cannot go red is worse than no tick. Verified
// against the live vault: with the session-start gate removed, retrieve.mjs injects 5 notes into
// EACH of these (10 in total) and this eval exits 1. It does that because ftsSim normalizes BM25
// against the BEST hit, so one generic shared token makes rank 1 score sim = 1.0 and sail straight
// over start_min_sim.
const UNKNOWN = ['some-unknown-repo', 'notes-app'];
// UNKNOWN goes FIRST so a vault with many repos can never truncate the probes away: the cap bounds
// runtime, and it used to sit at roughly the current repo count, one new repo away from silently
// dropping an unknown probe out of the prompt arm and quietly weakening this eval. The probe SET is
// unchanged from before (same repos, same 280 negative probes); only the order is.
const REPOS = [...new Set([...UNKNOWN, ...known])].slice(0, 20);

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

// SESSION-START ARM. Everything above drives retrieve-prompt.mjs, and for a long time that was the
// only injection surface anyone measured. The OTHER one, retrieve.mjs, shipped with no precision
// gate at all and injected the full k into ANY directory, including one that does not exist and is
// named in no note. The prompt arm is structurally blind to that: this hook is driven by the cwd,
// not by a prompt, so no off-topic prompt can ever provoke it.
// Count NOTE BLOCKS, not stdout emptiness. This hook always prints a header, the memory catalog and
// pinned preferences even when it retrieves nothing, and that is correct: cold-start orientation is
// not a retrieval guess and must not be gated away. Only "## " blocks are retrieved notes.
const startNotes = repo => {
  const out = spawnSync(process.execPath, [join(ROOT, 'scripts', 'retrieve.mjs')], {
    input: JSON.stringify({ session_id: `neg-start-${Math.random()}`, cwd: cwdFor(repo), source: 'startup' }),
    encoding: 'utf8',
    // NO_CAPTURE also suppresses repo auto-registration, so probing a fake repo cannot write it into
    // the user's config.json or mint a repo card for it.
    env: { ...process.env, UNIFIED_MEM_NO_CAPTURE: '1' },
  }).stdout || '';
  return (out.match(/^## /gm) || []).length;
};
const startFp = UNKNOWN.reduce((n, r) => n + startNotes(r), 0);
// Both halves or neither. "Abstain on every repo" scores a perfect zero above, so a repo the vault
// DOES know must still retrieve. That is the regression this has to keep catching: an earlier
// session-start gate scored a coverage RATIO instead of a rare-term hit count, and because the
// git-derived query runs to hundreds of terms the ratio collapsed and took a real repo to zero.
//
// The probe repo is chosen by EVIDENCE, not by array order, and getting that predicate right IS the
// test. These probe paths are not git repos, so the ENTIRE session-start query is the folder NAME
// (in a real session it is the name plus branch, commit subjects and changed files). So the arm may
// only demand a hit from a repo whose name the vault can actually ANSWER: some note must hold >= 2
// of the rare terms that name yields. A repo whose name yields fewer is not a failing gate, it is a
// folder name that is not evidence, and demanding a hit there would make a CORRECT build go red.
const answerable = db.prepare("SELECT title,entities,body,triggers FROM notes WHERE status != 'archived' AND trust != 'demo'").all();
const startProbe = [...new Set(known)]
  .map(r => { const { rare } = rarityGate(db, tokenize(r)); return { repo: r, rare, can: rare.size >= 2 && answerable.some(n => rareHits(n, rare) >= 2) }; })
  .sort((a, b) => (b.can - a.can) || (b.rare.size - a.rare.size))[0];
const startConclusive = !!startProbe?.can;
const startHits = startConclusive ? startNotes(startProbe.repo) : 0;

console.log(`negatives: ${fp}/${negTotal} false positives (${(100 * fp / negTotal).toFixed(1)}%)  [target 0]`);
console.log(startConclusive
  ? `session-start: ${startFp} notes into ${UNKNOWN.length} unknown repos [target 0], ${startHits} into "${startProbe.repo}" [target >=1]`
  : `session-start: ${startFp} notes into ${UNKNOWN.length} unknown repos [target 0]; POSITIVE ARM INCONCLUSIVE (no known repo name carries 2 rare terms, so the probe query is too weak to demand a hit)`);
console.log(titles.length
  ? `positives: ${hits}/${titles.length} notes retrievable by their own title   [target ${titles.length}]`
  : 'positives: NO ELIGIBLE NOTES: this vault cannot retrieve anything, so the negative arm proves nothing');

for (const [prompt, n] of [...leaks].sort((a, b) => b[1] - a[1]))
  console.log(`  LEAK x${n}: "${prompt}"`);
if (VERBOSE) for (const m of misses) console.log(`  MISS: ${m}`);

// A prompt that leaks in EVERY repo tripped the gate on its own words. A prompt that leaks in only
// SOME repos means the cwd is bleeding into the query again, which is the specific regression this
// file exists to catch. Name the mechanism so the next reader does not have to rediscover it.
if (leaks.size && [...leaks.values()].some(n => n < REPOS.length))
  console.log('\n  ^ leaks vary BY REPO: the cwd is entering the query again (see retrieve-prompt.mjs)');

// An empty vault cannot retrieve anything, so every negative probe abstains for the most trivial
// reason available and the run proves precisely nothing. That is not a pass, it is an absent test:
// with the cwd-in-query bug deliberately put back, an empty vault STILL reports zero false positives
// and exits 0. A green tick that cannot go red is worse than no tick, because it is trusted. Refuse
// to score a vault that has nothing to retrieve.
// startFp is a hard gate on every vault. The session-start POSITIVE arm is only demanded when the
// probe query can actually carry evidence (startConclusive), so CI keeps the "abstain on
// everything" degenerate solution failing loudly, while a vault whose repo names happen to be short
// reports itself inconclusive instead of fabricating a verdict.
const ok = fp === 0 && titles.length > 0 && hits === titles.length
  && startFp === 0 && (!startConclusive || startHits > 0);
console.log(ok ? '\nRETRIEVAL OK' : '\nRETRIEVAL REGRESSION');
process.exit(ok ? 0 : 1);
