import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mode = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : 'ok';
const port = Number(process.env.PORT || 4173);
const now = Date.now();
const iso = offset => new Date(now + offset).toISOString();
const projects = [
  { id: 1, name: 'timetracker', archived: false }, { id: 2, name: 'research', archived: false },
  { id: 3, name: 'work', archived: false }, { id: 4, name: 'archive', archived: true },
];
const activities = ['Assigned Task', 'implement', 'review', 'debug', 'research', 'write', 'plan', 'ops']
  .map((name, index) => ({ id: index + 1, name }));
const users = [
  { id: 1, username: 'admin', role: 'admin', active: true },
  { id: 2, username: 'agent-claude-code', role: 'agent', active: true },
  { id: 3, username: 'agent-codex', role: 'agent', active: true },
];
const entry = (id, task_id, description, activity_id, project_id, user_id, begin, end, end_reason = null, repo = 'timetracker') => ({
  id, task_id, description, activity_id, project_id, user_id, begin: iso(begin), end: end === null ? null : iso(end), end_reason, repo,
  auto_closed: end_reason === 'auto', tokens_input: 100, tokens_output: 20, tokens_reasoning: 5, tokens_cache_read: 10, tokens_cache_write: 0,
});
const entries = [
  entry(1, 1, 'running dashboard fixture', 2, 1, 1, -3600000, null, null, 'timetracker'),
  entry(2, 2, 'orphan paused fixture', 3, 2, 2, -48 * 3600000, -47 * 3600000, 'paused', 'research'),
  entry(3, 3, 'auto closed fixture', 4, 3, 3, -10 * 3600000, -2 * 3600000, 'auto', 'work'),
  entry(4, 4, 'multi segment fixture', 5, 1, 2, -4 * 3600000, -3 * 3600000, 'paused'),
  entry(5, 4, 'multi segment fixture', 5, 1, 2, -2 * 3600000, -3600000, 'done'),
  ...activities.slice(0, 8).map((activity, index) => entry(10 + index, 10 + index, `${activity.name} fixture`, activity.id, (index % 3) + 1, (index % 3) + 1, -(index + 1) * 7200000, -index * 7200000, 'done', ['timetracker', 'research', 'work'][index % 3])),
];
const fixture = { '/api/projects': projects, '/api/activities': activities, '/api/users': users, '/api/timesheets': entries, '/api/recommended-tasks': [] };
const types = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const patches = [];

const server = createServer(async (req, res) => {
  const path = new URL(req.url, `http://${req.headers.host}`).pathname;
  const timesheetPatch = /^\/api\/timesheets\/(\d+)$/.exec(path);
  if (timesheetPatch && req.method === 'PATCH') {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      patches.push({ id: Number(timesheetPatch[1]), body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
    });
    return;
  }
  if (path.startsWith('/api/')) {
    if (mode === 'error') { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ detail: 'fixture error' })); return; }
    const body = path === '/api/patches' ? patches : mode === 'empty' && path === '/api/timesheets' ? [] : fixture[path];
    if (body === undefined) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); return;
  }
  const file = path === '/' ? 'index.html' : normalize(path).replace(/^[/\\]+/, '');
  if (file.startsWith('..')) { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(join(root, file));
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }); res.end(body);
  } catch {
    res.writeHead(404); res.end();
  }
});
server.listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}`));
