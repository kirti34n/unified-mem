// Live vault dashboard: zero-dependency http server on :7777.
// Serves dashboard/index.html + /api/state (full vault snapshot, polled by the page).
// --export <dir>: writes a fully static copy (state inlined as window.__STATE__,
// no polling, relative vendor paths) that renders offline from file:// or Pages.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { openDb, todaySpendUsd, CONFIG, ROOT, VAULT } from './vault.mjs';

const PORT = Number(process.env.PORT || 7777);
const db = openDb();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function state() {
  const all = t => db.prepare(`SELECT * FROM ${t}`).all();
  const notes = all('notes');
  const summary = {
    active: notes.filter(n => n.status === 'active').length,
    needs_review: notes.filter(n => n.status === 'needs-review').length,
    archived: notes.filter(n => n.status === 'archived').length,
    mean_q: notes.filter(n => n.status !== 'archived')
      .reduce((s, n, _, a) => s + n.q_value / a.length, 0),
    retrievals: db.prepare('SELECT COUNT(*) c FROM injections').get().c,
    stale_rate: (() => {
      const m = db.prepare('SELECT SUM(stale_retrievals) s, SUM(retrievals) r FROM metrics_daily').get();
      return m.r ? m.s / m.r : 0;
    })(),
    abstention_rate: (() => {
      const s = db.prepare('SELECT COUNT(*) c FROM sessions WHERE demo=0').get().c;
      const w = db.prepare('SELECT COUNT(DISTINCT session_id) c FROM injections WHERE demo=0').get().c;
      return s ? (s - w) / s : 0;
    })(),
    gaps: (() => {
      try { return readFileSync(join(VAULT, 'index', 'gaps.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length; }
      catch { return 0; }
    })(),
    spend_today_usd: todaySpendUsd(),
    daily_budget_usd: CONFIG.daily_budget_usd,
  };
  return {
    generated_at: new Date().toISOString(),
    summary, notes,
    sessions: all('sessions').sort((a, b) => b.ts.localeCompare(a.ts)),
    injections: all('injections'),
    q_history: all('q_history'),
    consolidations: all('consolidations').sort((a, b) => b.ts.localeCompare(a.ts)),
    metrics: all('metrics_daily').sort((a, b) => a.date.localeCompare(b.date)),
  };
}

const argv = process.argv.slice(2);
if (argv.includes('--export')) {
  const outDir = argv[argv.indexOf('--export') + 1] || join(ROOT, 'docs', 'demo-site');
  mkdirSync(join(outDir, 'vendor'), { recursive: true });
  for (const f of readdirSync(join(ROOT, 'dashboard', 'vendor')))
    copyFileSync(join(ROOT, 'dashboard', 'vendor', f), join(outDir, 'vendor', f));
  let html = readFileSync(join(ROOT, 'dashboard', 'index.html'), 'utf8')
    .replaceAll('href="/vendor/', 'href="vendor/')
    .replaceAll('src="/vendor/', 'src="vendor/')
    .replace("const r=await fetch('/api/state');S=await r.json();", 'S=window.__STATE__;')
    .replace('poll();setInterval(poll,5000);', 'poll();')
    .replace('<span class="live"><span class="dot"></span>LIVE</span>',
      '<span class="live">static demo · fictional seed data · <a href="https://github.com/kirti34n/unified-mem" style="color:inherit">get the real thing</a></span>')
    .replace('</head>', `<script>window.__STATE__=${JSON.stringify(state())}</script>\n</head>`);
  writeFileSync(join(outDir, 'index.html'), html);
  console.log(`static dashboard exported to ${outDir}`);
  process.exit(0);
}

createServer((req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (url === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(state()));
    }
    const file = url === '/' ? 'index.html' : url.replace(/^\/+|\.\./g, '');
    const body = readFileSync(join(ROOT, 'dashboard', file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`unified-mem dashboard → http://localhost:${PORT}`)); // localhost only: the vault is private
