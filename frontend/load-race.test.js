import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { stableColorById } from './helpers.js';

const PATHS = {
  projects: '/api/projects', activities: '/api/activities', users: '/api/users',
  entries: '/api/timesheets', recommendedTasks: '/api/recommended-tasks',
};
const KEYS = Object.keys(PATHS);

// Runs the real api() and load() source from app.js; only fetch, DOM and render are stubbed.
// loadSeq must be declared between typingInField and the end of load() to be picked up here.
const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const apiSource = app.match(/const api = async [\s\S]*?\n\};/)?.[0];
const loadStart = app.indexOf('const typingInField');
const loadEnd = app.indexOf('\n}\n', app.indexOf('async function load(')) + 2;
assert.ok(apiSource && loadStart >= 0 && loadEnd > loadStart, 'api/load source not found in app.js');
const loadSource = `${apiSource}\n${app.slice(loadStart, loadEnd)}\n;({ load })`;

const e1 = { id: 1, begin: '2026-10-14T01:00:00Z', end: '2026-10-14T02:00:00Z' };
const e2 = { id: 2, begin: '2026-10-14T03:00:00Z', end: null };
const seeded = { id: 9, begin: '2026-10-13T01:00:00Z', end: '2026-10-13T02:00:00Z' };

function setup() {
  const calls = {};
  const env = { renders: 0, now: 1000, typing: false, modalForm: false, calls };
  env.state = {
    error: '', lastUpdated: null, stale: false, pending: new Set(), draft: { title: 'keep me' },
    projects: [{ id: 1 }], activities: [{ id: 1 }], users: [], entries: [seeded], recommendedTasks: [{ id: 1 }],
  };
  const response = data => ({ ok: true, status: 200, type: 'basic', redirected: false, json: async () => data });
  const fetch = path => new Promise((resolve, reject) => { (calls[path] ??= []).push({ resolve: data => resolve(response(data)), reject }); });
  const activeElement = { matches: () => true };
  const { load } = runInNewContext(loadSource, {
    state: env.state, fetch, Date: { now: () => env.now },
    render: () => { env.renders++; },
    entityLabel: username => username, stableColorById, colors: ['c1', 'c2'],
    $app: { contains: el => env.typing && el === activeElement },
    document: { activeElement, querySelector: () => (env.modalForm ? {} : null) },
  });
  // Starts a load and captures its five in-flight requests; values that are Errors reject.
  env.start = silent => {
    const done = load(silent);
    const pending = Object.fromEntries(KEYS.map(key => [key, calls[PATHS[key]].at(-1)]));
    const settle = (values = {}) => KEYS.forEach(key => {
      const value = values[key] ?? [];
      if (value instanceof Error) pending[key].reject(value); else pending[key].resolve(value);
    });
    return { done, settle };
  };
  env.published = () => structuredClone(Object.fromEntries(KEYS.map(key => [key, env.state[key]])));
  return env;
}

test('older success resolving after a newer load is dropped', async () => {
  const env = setup();
  const a = env.start(true), b = env.start(false);
  env.now = 2000;
  b.settle({ entries: [e1, e2] });
  await b.done;
  assert.deepEqual(env.state.entries, [e1, e2]);
  assert.equal(env.renders, 1);
  env.now = 3000;
  a.settle({ entries: [e1] });
  await a.done;
  assert.deepEqual(env.state.entries, [e1, e2]);
  assert.equal(env.state.lastUpdated, 2000);
  assert.equal(env.renders, 1);
});

test('older failure after a newer success leaves error and stale untouched', async () => {
  const env = setup();
  const a = env.start(true), b = env.start(false);
  b.settle({ entries: [e1, e2] });
  await b.done;
  a.settle({ entries: new Error('late') });
  await a.done;
  assert.equal(env.state.error, '');
  assert.equal(env.state.stale, false);
  assert.deepEqual(env.state.entries, [e1, e2]);
  assert.equal(env.renders, 1);
});

test('newest failure is published and keeps prior entries and drafts', async () => {
  const env = setup();
  const a = env.start(false);
  a.settle({ entries: [e1] });
  await a.done;
  const b = env.start(true);
  b.settle({ entries: new Error('boom') });
  await b.done;
  assert.equal(env.state.error, 'Could not load live data: boom');
  assert.equal(env.state.stale, true);
  assert.deepEqual(env.state.entries, [e1]);
  assert.deepEqual(env.state.draft, { title: 'keep me' });
  assert.equal(env.renders, 2);
});

test('newer failure followed by older success retains the previous complete state', async () => {
  const env = setup();
  const before = env.published();
  const a = env.start(true), b = env.start(true);
  b.settle({ entries: new Error('boom') });
  await b.done;
  a.settle({ entries: [e1, e2], projects: [{ id: 2 }] });
  await a.done;
  assert.deepEqual(env.published(), before);
  assert.equal(env.state.error, 'Could not load live data: boom');
  assert.equal(env.state.stale, true);
  assert.equal(env.state.lastUpdated, null);
  assert.equal(env.renders, 1);
});

test('a single load publishes all state, lastUpdated and one render', async () => {
  const env = setup();
  env.now = 4242;
  const a = env.start(false);
  a.settle({
    projects: [{ id: 5 }], activities: [{ id: 6 }], users: [{ id: 7, username: 'admin' }],
    entries: [e1], recommendedTasks: [{ id: 8 }],
  });
  await a.done;
  assert.deepEqual(env.state.projects, [{ id: 5 }]);
  assert.deepEqual(env.state.activities, [{ id: 6 }]);
  assert.deepEqual(env.state.users.map(u => [u.id, u.label, u.short, u.color]), [[7, 'admin', 'admin', 'c2']]);
  assert.deepEqual(env.state.entries, [e1]);
  assert.deepEqual(env.state.recommendedTasks, [{ id: 8 }]);
  assert.equal(env.state.error, '');
  assert.equal(env.state.stale, false);
  assert.equal(env.state.lastUpdated, 4242);
  assert.equal(env.renders, 1);
});

test('a pending modal form suppresses render on success and failure', async () => {
  const env = setup();
  env.state.pending.add('modal-form');
  const ok = env.start(false);
  ok.settle({ entries: [e1] });
  await ok.done;
  assert.deepEqual(env.state.entries, [e1]);
  const bad = env.start(false);
  bad.settle({ entries: new Error('boom') });
  await bad.done;
  assert.equal(env.state.error, 'Could not load live data: boom');
  assert.equal(env.renders, 0);
});

test('a failed request publishes none of the five resources', async () => {
  for (const failing of KEYS) {
    const env = setup();
    const before = env.published();
    const a = env.start(false);
    a.settle({
      projects: [{ id: 5 }], activities: [{ id: 6 }], users: [{ id: 7, username: 'u' }],
      entries: [e1], recommendedTasks: [{ id: 8 }], [failing]: new Error(`${failing} down`),
    });
    await a.done;
    assert.deepEqual(env.published(), before, failing);
    assert.equal(env.state.error, `Could not load live data: ${failing} down`);
  }
});

test('silent loads publish but do not render while typing or a modal form is open', async () => {
  for (const field of ['typing', 'modalForm']) {
    const env = setup();
    env[field] = true;
    const ok = env.start(true);
    ok.settle({ entries: [e1] });
    await ok.done;
    assert.deepEqual(env.state.entries, [e1], field);
    const bad = env.start(true);
    bad.settle({ entries: new Error('boom') });
    await bad.done;
    assert.equal(env.state.stale, true, field);
    assert.equal(env.renders, 0, field);
    const loud = env.start(false);
    loud.settle({ entries: [e1, e2] });
    await loud.done;
    assert.equal(env.renders, 1, field);
  }
});
