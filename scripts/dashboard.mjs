// Live vault dashboard: zero-dependency http server on :7777.
// Serves dashboard/index.html + /api/state (full vault snapshot, polled by the page).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
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
