// One-time setup: creates the vault directory (the user's data, separate from
// this tool checkout), initializes it as its own git repo, and writes a starter
// config.json next to the tool if none exists.
// Usage: node scripts/init.mjs   (vault location: UNIFIED_MEM_VAULT_DIR env,
// then vault_dir in config.json, then ~/.unified-mem/vault)
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ROOT, CONFIG, CONFIG_PATH, DEFAULT_VAULT } from './vault.mjs';

const expandHome = p => p.replace(/^~(?=[\\/]|$)/, homedir());
// deliberately skip the legacy in-checkout fallback: init's whole job is the split
const target = process.env.UNIFIED_MEM_VAULT_DIR
  ? resolve(expandHome(process.env.UNIFIED_MEM_VAULT_DIR))
  : CONFIG.vault_dir ? resolve(expandHome(CONFIG.vault_dir)) : DEFAULT_VAULT;

mkdirSync(join(target, 'notes'), { recursive: true });
mkdirSync(join(target, 'index'), { recursive: true });
mkdirSync(join(target, 'queue'), { recursive: true });

const gi = join(target, '.gitignore');
if (!existsSync(gi)) writeFileSync(gi, `# derived caches, machine-local: never share
index/
queue/
eval-results/
improve/
# notes/, entities/, repos/ are TRACKED: they are the vault
# uncomment to keep personal preferences/docs out of a shared vault repo:
# notes/personal/
`);

if (!existsSync(join(target, '.git'))) {
  const r = spawnSync('git', ['init', '-b', 'main'], { cwd: target, encoding: 'utf8' });
  console.log(r.status === 0 ? `git repo initialized in ${target}` : 'git init failed (git not installed?); vault works without it, but you lose history/sharing');
} else {
  console.log(`vault already a git repo: ${target}`);
}

const cfgPath = CONFIG_PATH;
if (!existsSync(cfgPath)) {
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({ vault_dir: target.replace(/\\/g, '/'), repos: {} }, null, 2) + '\n');
  console.log(`wrote ${cfgPath} (vault_dir + empty repos map)`);
} else if (!CONFIG.vault_dir && !process.env.UNIFIED_MEM_VAULT_DIR) {
  console.log(`NOTE: config.json exists but has no vault_dir. Add "vault_dir": "${target.replace(/\\/g, '/')}" to use the new vault; without it a legacy ./notes dir in the checkout still wins.`);
}

console.log(`
vault ready: ${target}
next steps:
  node scripts/seed.mjs         # optional: demo data to explore the dashboard
  node scripts/dashboard.mjs    # http://localhost:7777
  add the three hooks from the README to ~/.claude/settings.json
  fill the repos map in config.json to enable staleness detection`);
