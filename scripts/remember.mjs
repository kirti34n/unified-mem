// One-liner personal capture without the MCP server:
//   node scripts/remember.mjs "Prefer pnpm over npm in all projects"
//   node scripts/remember.mjs --note "Deploys happen only from the main branch"
// Same validation path as vault_remember (schema gate, secrets, 150-word cap).
import { rememberNote } from './vault.mjs';

const args = process.argv.slice(2);
const kind = args.includes('--note') ? 'note' : 'preference';
const text = args.filter(a => !a.startsWith('--')).join(' ');

try {
  const id = rememberNote(text, { kind, sessionId: 'cli' });
  console.log(kind === "preference" ? `saved: ${id} (preference, pinned into every future session)` : `saved: ${id} (note, surfaces when a prompt matches it)`);
} catch (e) {
  console.error(`not saved: ${e.message}`);
  process.exit(1);
}
