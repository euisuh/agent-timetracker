import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { clipEntriesToWindow, dayKey, groupByDay, groupIntoTasks, taskDurationMs } from './helpers.js';

const at = (day, hour) => new Date(2026, 0, day, hour).getTime();
const iso = ms => new Date(ms).toISOString();

test('selected window includes overlapping segments and clips both boundaries without mutating records', () => {
  const entries = [
    { id: 1, task_id: null, user_id: 1, begin: iso(at(1, 23)), end: iso(at(2, 1)), tokens_input: 17 },
    { id: 2, task_id: 1, user_id: 1, begin: iso(at(2, 23)), end: iso(at(3, 1)) },
    { id: 3, task_id: 1, user_id: 2, begin: iso(at(2, 0)), end: iso(at(2, 2)) },
    { id: 4, task_id: 4, user_id: 1, begin: iso(at(1, 22)), end: iso(at(2, 0)) },
  ];
  const original = structuredClone(entries);
  const clipped = clipEntriesToWindow(entries, at(2, 0), at(3, 0), at(4, 0));
  const tasks = groupIntoTasks(clipped, { ownerScoped: true });
  assert.equal(clipped.length, 3);
  assert.equal(taskDurationMs(tasks.find(task => task.key === '1:1')), 2 * 3600000);
  assert.equal(taskDurationMs(tasks.find(task => task.key === '2:1')), 2 * 3600000);
  assert.equal(clipped[0].tokens_input, 17);
  assert.deepEqual(entries, original);
});

test('open durations remain clipped to now and a historical window stays closed', () => {
  const entry = { id: 1, user_id: 1, task_id: 1, begin: iso(at(1, 23)), end: null };
  const live = clipEntriesToWindow([entry], at(2, 0), at(3, 0), at(2, 2))[0];
  assert.equal(live.end, null);
  assert.equal(taskDurationMs({ segments: [live] }, at(2, 2)), 2 * 3600000);
  const history = clipEntriesToWindow([entry], at(1, 0), at(2, 0), at(2, 2))[0];
  assert.equal(history.end, iso(at(2, 0)));
  assert.equal(taskDurationMs({ segments: [history] }, at(2, 2)), 3600000);
});

test('activity heatmaps distribute overnight durations across local calendar days', () => {
  const entries = [{ user_id: 2, begin: iso(at(1, 23)), end: iso(at(2, 1)) }];
  assert.deepEqual([...groupByDay(entries, 2, at(3, 0))], [[dayKey(new Date(at(1, 0))), 3600000], [dayKey(new Date(at(2, 0))), 3600000]]);
  assert.deepEqual([...groupByDay(entries, 1, at(3, 0))], []);
});

test('local day boundaries use the 23-hour DST calendar day', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { clipToDay, groupByDay } from './helpers.js';
    const day = new Date(2026, 2, 8), next = new Date(2026, 2, 9);
    const entry = { user_id: 1, begin: day.toISOString(), end: next.toISOString() };
    assert.equal([...groupByDay([entry])][0][1], 23 * 3600000);
    assert.equal(clipToDay({ ...entry, end: new Date(2026, 2, 9, 1).toISOString() }, day).endMin, 23 * 60);
  `], { cwd: new URL('.', import.meta.url), env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
