// Minimal MCP stdio server exposing vault_search — the opt-in PULL path (R10).
// Register (opt-in; the push path via hooks remains primary):
//   claude mcp add --scope user vault-search -- node /path/to/unified-mem/scripts/mcp-server.mjs
import { createInterface } from 'node:readline';
import { openDb, scoreNotes, tokenize } from './vault.mjs';

const db = openDb();
const TOOL = {
  name: 'vault_search',
  description: 'Search the team knowledge vault (cross-repo notes: past fixes, patterns, decisions, conventions). Returns the top-k notes ranked by relevance × learned usefulness.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for (error message, technology, pattern)' },
      repo: { type: 'string', description: 'Optional repo name to bias results toward' },
      k: { type: 'number', description: 'Max notes to return (default 5)' },
    },
    required: ['query'],
  },
};

function search({ query, repo = '', k = 5 }) {
  const notes = scoreNotes(db, tokenize(`${query} ${repo}`), k);
  if (!notes.length) return 'No matching notes in the vault.';
  return notes.map(n =>
    `## ${n.title}${n.status === 'needs-review' ? ' [NEEDS REVIEW — verify against code]' : ''}\n` +
    `(${n.id} · type: ${n.type} · repos: ${n.repos} · files: ${n.files} · commit: ${n.source_commit} · Q ${n.q_value.toFixed(2)})\n${n.body}`
  ).join('\n\n');
}

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');

createInterface({ input: process.stdin }).on('line', line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') return reply(id, {
    protocolVersion: params?.protocolVersion || '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: { name: 'unified-mem', version: '1.0.0' },
  });
  if (method === 'tools/list') return reply(id, { tools: [TOOL] });
  if (method === 'tools/call') {
    if (params?.name !== 'vault_search') return fail(id, -32602, `unknown tool: ${params?.name}`);
    try { return reply(id, { content: [{ type: 'text', text: search(params.arguments || {}) }] }); }
    catch (e) { return fail(id, -32603, e.message); }
  }
  if (id !== undefined) return fail(id, -32601, `method not found: ${method}`); // notifications: silently ignored
});
