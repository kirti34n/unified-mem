// Ingest personal docs (style guides, onboarding notes, house conventions) as
// reference notes. Chunked by ## heading, 400-word cap per chunk; chunks flow
// through the normal per-prompt retrieval (rare-term gated), never pinned.
//   node scripts/ingest.mjs <file-or-dir> [--entities a,b]
// Re-ingesting a file replaces its previous chunks (matched on source_path).
// Staleness: consolidate re-hashes source files nightly (see P3.6).
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { userInfo, hostname } from 'node:os';
import { openDb, reindexNotes, parseNote, validateNote, walkNotes, NOTES_DIR, SECRET_RE } from './vault.mjs';

const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith('--'));
if (!target) { console.error('usage: node scripts/ingest.mjs <file-or-dir> [--entities a,b]'); process.exit(1); }
const entities = args.includes('--entities') ? args[args.indexOf('--entities') + 1] : '';

const files = [];
const st = statSync(resolve(target));
if (st.isDirectory()) {
  for (const f of readdirSync(resolve(target)))
    if (['.md', '.txt'].includes(extname(f).toLowerCase())) files.push(join(resolve(target), f));
} else {
  files.push(resolve(target));
}

const db = openDb();
const personalDir = join(NOTES_DIR, 'personal');
mkdirSync(personalDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 5).join('-') || 'doc';

// split a section into <=400-word parts at word boundaries
function parts(text, cap = 400) {
  const words = text.trim().split(/\s+/);
  const out = [];
  for (let i = 0; i < words.length; i += cap) out.push(words.slice(i, i + cap).join(' '));
  return out.filter(Boolean);
}

let written = 0, skipped = 0, replaced = 0;
for (const file of files) {
  const abs = file.replace(/\\/g, '/');
  const raw = readFileSync(file, 'utf8');
  const hash = createHash('sha256').update(raw).digest('hex');

  // replace previous chunks of this source
  for (const p of [...walkNotes()]) {
    const n = parseNote(readFileSync(p, 'utf8'), p);
    if (n?.type === 'reference' && n.source_path === abs) {
      unlinkSync(p);
      db.prepare('DELETE FROM notes WHERE id=?').run(n.id);
      replaced++;
    }
  }

  const docTitle = (raw.match(/^# (.+)$/m)?.[1] || basename(file, extname(file))).trim();
  const sections = [];
  const chunks = raw.split(/^## /m);
  if (chunks[0].replace(/^# .+$/m, '').trim()) sections.push(['Introduction', chunks[0].replace(/^# .+$/m, '').trim()]);
  for (const c of chunks.slice(1)) {
    const nl = c.indexOf('\n');
    sections.push([c.slice(0, nl < 0 ? c.length : nl).trim(), nl < 0 ? '' : c.slice(nl + 1).trim()]);
  }

  let n = 0;
  for (const [heading, body] of sections) {
    if (!body) continue;
    for (const [pi, part] of parts(body).entries()) {
      if (SECRET_RE.test(part)) { console.warn(`skipped chunk "${heading}" (${basename(file)}): secret pattern detected`); skipped++; continue; }
      n++;
      const id = `${today}-ref-${slugify(docTitle)}-${n}`;
      const title = `${docTitle}: ${heading}${pi > 0 ? ` (part ${pi + 1})` : ''}`.slice(0, 100);
      const note = `---
id: ${id}
type: reference
title: ${title}
entities: [${entities}]
repos: []
files: []
source_commit: doc
confidence: high
q_value: 0.50
access_count: 0
last_used: null
last_validated: ${today}
status: active
scope: personal
source_path: ${abs}
source_hash: ${hash}
author: ${userInfo().username}
machine: ${hostname()}
source_session: ingest-cli
trust: user-doc
links: []
---
${part}
`;
      const invalid = validateNote(parseNote(note), ['reference']);
      if (invalid) { console.warn(`skipped chunk "${heading}": ${invalid}`); skipped++; continue; }
      writeFileSync(join(personalDir, `${id}.md`), note);
      written++;
    }
  }
}
reindexNotes(db);
console.log(`ingested: ${written} chunks written${replaced ? `, ${replaced} previous chunks replaced` : ''}${skipped ? `, ${skipped} skipped` : ''}`);
