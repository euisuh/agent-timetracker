import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { clipEntriesToWindow, formatDuration, groupIntoTasks, taskDurationMs } from './helpers.js';

test('elapsed ticks skip history without labels and resume live and scoped updates', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const source = app.match(/function tickElapsed\(\) \{[\s\S]*?\n\}/)[0];
  const entries = [
    { id: 101, task_id: null, user_id: 1, begin: '2026-10-13T23:00:00Z', end: '2026-10-14T01:00:00Z' },
    { id: 102, task_id: 101, user_id: 1, begin: '2026-10-14T01:30:00Z', end: null },
    { id: 103, task_id: 101, user_id: 2, begin: '2026-10-14T00:30:00Z', end: '2026-10-14T01:00:00Z' },
  ];
  const original = structuredClone(entries);
  const calls = { query: 0, group: 0, clip: 0, window: 0, duration: 0 };
  let labels = [], now = Date.parse('2026-10-14T02:00:00Z');
  const tick = runInNewContext(`${source}; tickElapsed`, {
    state: { entries }, Date: { now: () => now },
    document: { querySelectorAll: selector => { assert.equal(selector, '[data-elapsed]'); calls.query++; return labels; } },
    groupIntoTasks: (...args) => { calls.group++; return groupIntoTasks(...args); },
    clipEntriesToWindow: (...args) => { calls.clip++; return clipEntriesToWindow(...args); },
    timesheetWindow: () => { calls.window++; return [Date.parse('2026-10-14T00:00:00Z'), now]; },
    stableId: task => task.key,
    taskDurationMs: task => { calls.duration++; return taskDurationMs(task, now); },
    formatDuration,
  });
  tick();
  assert.deepEqual(calls, { query: 1, group: 0, clip: 0, window: 0, duration: 0 });

  labels = [
    { dataset: { taskKey: '1:101' }, textContent: 'live' },
    { dataset: { taskKey: '1:101', elapsedScope: 'selected' }, textContent: 'scoped' },
    { dataset: { elapsed: '2:101' }, textContent: 'other owner' },
    { dataset: { taskKey: 'missing' }, textContent: 'unchanged' },
  ];
  tick();
  assert.deepEqual(calls, { query: 2, group: 2, clip: 1, window: 1, duration: 3 });
  assert.deepEqual(labels.map(label => label.textContent), ['2h 30m', '1h 30m', '30m 00s', 'unchanged']);
  now += 60000;
  tick();
  assert.deepEqual(labels.map(label => label.textContent), ['2h 31m', '1h 31m', '30m 00s', 'unchanged']);
  const beforeEmpty = { ...calls };
  labels = [];
  tick();
  assert.deepEqual(calls, { ...beforeEmpty, query: beforeEmpty.query + 1 });
  assert.deepEqual(entries, original);
});
