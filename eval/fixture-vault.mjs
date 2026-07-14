// Build a small, deterministic vault for eval/negatives.mjs to score against.
//
// Why this file has to exist at all: an empty vault cannot retrieve anything, so every negative
// probe abstains for the most trivial reason available and the precision eval passes without
// testing anything. Verified: with the cwd-in-query regression deliberately put back, an empty
// vault still reports zero false positives and exits 0. CI was green on a test that could not fail.
//
// starter.mjs cannot stand in for this. Its notes carry `repos: []`, and the regression this eval
// exists to catch is the working directory's name leaking into the retrieval query. That leak can
// only express itself against notes actually TAGGED with the repo being probed: the folder name
// has to match something. So the fixture deliberately tags notes with repo names, and negatives.mjs
// then probes from those very repos.
//
// The notes are real technical content with genuinely rare vocabulary, because the gate they are
// meant to exercise keys on rare terms. Fake lorem text would have every token at df 0 and would
// test the wrong thing.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, reindexNotes, NOTES_DIR, VAULT } from '../scripts/vault.mjs';

// The repo name is chosen so the regression can actually EXPRESS itself, which is subtler than it
// looks and is why a first attempt at this fixture silently proved nothing.
//
// The original bug injected a note when the working directory's name supplied two "rare" query
// terms on its own. So the fixture repo has to be named such that its basename tokenizes to two
// terms that (a) survive the length floor, and (b) appear in that repo's own notes. "billing-service"
// gives "billing" and "service", both long enough to count, and the notes below are genuinely about
// a billing service, so both words are in their text. That is not a contrivance: it IS the real
// condition, because a repo's name is by construction common in that repo's own notes.
//
// A name like "notes-app" would NOT work: it yields "notes" and "app", and "app" is too short to
// count as evidence, so the gate closes for the wrong reason and the test passes while blind.
// Verified: with the cwd-in-query fold put back, this fixture goes red and "notes-app" does not.
const NOTES = [
  {
    id: '2026-01-05-billing-retry-storm',
    title: 'A retry storm in the billing service came from an unbounded exponential backoff',
    entities: 'billing, retries',
    triggers: 'when the billing service saturates its own upstream after a blip',
    repos: 'billing-service',
    files: 'src/billing/retry.ts',
    body: '**Problem:** a brief upstream outage in the billing service turned into a self-sustaining retry storm. **Root cause:** exponential backoff with no ceiling and no jitter, so every client retried in lockstep. **Fix:** cap the backoff and add full jitter, so the billing service spreads its retries instead of synchronising them. **Gotchas:** the storm only appears under real concurrency, so a single-client test will never reproduce it.',
  },
  {
    id: '2026-01-06-cp1252-console-crash',
    title: 'Printing unicode to a legacy Windows console raises UnicodeEncodeError',
    entities: 'windows, encoding',
    triggers: 'when emoji output crashes only on a real Windows terminal',
    repos: 'billing-service',
    files: 'scripts/report.py',
    body: '**Problem:** printing non-ASCII (emoji, box drawing) threw UnicodeEncodeError on a cp1252 console. **Fix:** reconfigure stdout to utf-8 at startup, or keep console output ASCII-only. **Gotchas:** it passes on macOS, on Linux, and in redirected pipes, so it only ever surfaces on a real Windows terminal.',
  },
  {
    id: '2026-01-07-ffmpeg-palette-banding',
    title: 'Animated GIF banding is fixed by a two-pass palette, not by raising bitrate',
    entities: 'ffmpeg, compression',
    triggers: 'when an exported GIF looks posterised and dithered',
    repos: 'render-pipeline',
    files: 'tools/encode.sh',
    body: '**Problem:** exported GIFs showed heavy banding regardless of scale. **Root cause:** the default 216-colour palette is chosen per frame. **Fix:** run ffmpeg twice, generating a palette across the whole clip with palettegen, then applying it with paletteuse. **Gotchas:** GIF has no bitrate knob, so raising quality settings does nothing.',
  },
];

mkdirSync(VAULT, { recursive: true });
const dir = join(NOTES_DIR, '2026', '01');
mkdirSync(dir, { recursive: true });

for (const n of NOTES) {
  const fm = [
    '---',
    `id: ${n.id}`,
    'type: recovery',
    `title: ${n.title}`,
    `entities: [${n.entities}]`,
    `triggers: ${n.triggers}`,
    `repos: [${n.repos}]`,
    `files: [${n.files}]`,
    'source_commit: fixture',
    'confidence: high',
    'q_value: 0.50',
    'access_count: 0',
    'last_used: null',
    'last_validated: 2026-01-07',
    'status: active',
    'trust: local',
    'links: []',
    '---',
    n.body,
    '',
  ].join('\n');
  writeFileSync(join(dir, `${n.id}.md`), fm);
}

const count = reindexNotes(openDb());
console.log(`fixture vault: ${NOTES.length} notes written, ${count} indexed, at ${VAULT}`);
