// Live vault dashboard: zero-dependency http server on :7777.
// Serves dashboard/index.html + /api/state (full vault snapshot, polled by the page).
// --export <dir>: writes a fully static copy (state inlined as window.__STATE__,
// no polling, relative vendor paths) that renders offline from file:// or Pages.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { openDb, todaySpendUsd, loadConfig, CONFIG, CONFIG_PATH, ROOT, VAULT } from './vault.mjs';

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
  // Repos view: everything the memory knows about, whether from the config map
  // (auto-registered on first session) or note provenance, with enable state.
  const cfg = loadConfig(); // fresh read: toggles must reflect without restart
  const repoNames = new Set(Object.keys(cfg.repos || {}));
  for (const n of notes) for (const r of (n.repos || '').split(',').map(s => s.trim()).filter(Boolean)) repoNames.add(r);
  const repos_ui = [...repoNames].map(name => ({
    name,
    path: cfg.repos?.[name] ?? null,
    notes: notes.filter(n => n.status !== 'archived' && (',' + n.repos + ',').includes(',' + name + ',')).length,
    last_session: db.prepare('SELECT MAX(ts) t FROM sessions WHERE repo=? AND demo=0').get(name).t,
    enabled: !(cfg.disabled_repos || []).includes(name),
  })).sort((a, b) => (b.last_session || '').localeCompare(a.last_session || ''));

  return {
    generated_at: new Date().toISOString(),
    summary, notes, repos_ui,
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
    .replace('</head>', () => {
      const s = state();
      // preferences and your docs never enter a shareable export; strip absolute paths
      // (note files and repo locations) so the export cannot leak the author's filesystem
      s.notes = s.notes.filter(n => n.scope !== 'personal').map(({ path, ...n }) => n);
      s.repos_ui = s.repos_ui.map(r => ({ ...r, path: null }));
      // escape '<' so a note body containing </script> cannot terminate the inline
      // script tag and inject live HTML (stored XSS on the published page)
      const json = JSON.stringify(s).replace(/</g, '\\u003c');
      return `<script>window.__STATE__=${json}</script>\n</head>`;
    });
  writeFileSync(join(outDir, 'index.html'), html);
  console.log(`static dashboard exported to ${outDir}`);
  process.exit(0);
}

createServer((req, res) => {
  try {
    // Host allowlist: defeats DNS-rebinding (a rebound name resolves to 127.0.0.1 but
    // arrives with the attacker's Host), so a web page cannot read the private vault.
    const host = (req.headers.host || '').split(':')[0];
    if (host && host !== 'localhost' && host !== '127.0.0.1') { res.writeHead(403); return res.end('forbidden'); }
    const url = req.url.split('?')[0];
    if (url === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(state()));
    }
    if (url === '/api/toggle-repo' && req.method === 'POST') {
      // CSRF guard: a cross-site fetch carries an Origin of the attacker's page; only
      // same-origin (or no-Origin, e.g. curl) may mutate config.
      const origin = req.headers.origin;
      if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) { res.writeHead(403); return res.end('forbidden'); }
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { name } = JSON.parse(body);
          if (!name || typeof name !== 'string') throw new Error('name required');
          const c = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
          const d = new Set(c.disabled_repos || []);
          d.has(name) ? d.delete(name) : d.add(name);
          c.disabled_repos = [...d];
          mkdirSync(dirname(CONFIG_PATH), { recursive: true });
          writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ name, enabled: !d.has(name) }));
        } catch (e) { res.writeHead(400); res.end(e.message); }
      });
      return;
    }
    const file = url === '/' ? 'index.html' : url.replace(/^\/+|\.\./g, '');
    const body = readFileSync(join(ROOT, 'dashboard', file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`unified-mem dashboard → http://localhost:${PORT}`)); // localhost only: the vault is private
