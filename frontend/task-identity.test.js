import test from 'node:test';
import assert from 'node:assert/strict';
import { groupIntoTasks, resolveTask, taskIdentity, taskKey } from './helpers.js';
import { needsAttention, parseReportRoute, summarize, taskHref } from './report-helpers.js';

const entry = (id, task_id, user_id, hour, extra = {}) => ({
  id, task_id, user_id, project_id: 1, activity_id: 2, description: `Entry ${id}`,
  begin: `2026-10-13T${String(hour).padStart(2, '0')}:00:00Z`,
  end: `2026-10-13T${String(hour + 1).padStart(2, '0')}:00:00Z`, end_reason: 'done', ...extra,
});
const scoped = { ownerScoped: true };

test('application identity separates null roots and task IDs belonging to different owners', () => {
  const rows = [entry(101, null, 1, 1), entry(102, null, 1, 3), entry(103, 500, 1, 5), entry(104, 500, 2, 7)];
  assert.deepEqual(groupIntoTasks(rows, scoped).map(task => [task.key, task.segments.map(part => part.id)]), [
    ['2:500', [104]], ['1:500', [103]], ['1:102', [102]], ['1:101', [101]],
  ]);
  assert.equal(taskIdentity(rows[0]), '1:101');
  assert.equal(taskIdentity(rows[3]), '2:500');
  assert.equal(taskKey(rows[2]), '500');
  assert.equal(groupIntoTasks([rows[2]])[0].key, '500');
});

test('application identity joins a legacy null root with resumed segments of the same owner', () => {
  const tasks = groupIntoTasks([entry(101, null, 1, 1), entry(102, 101, 1, 3), entry(103, 101, 2, 5)], scoped);
  assert.deepEqual(tasks.map(task => [task.key, task.segments.map(part => part.id)]), [['2:101', [103]], ['1:101', [101, 102]]]);
});

test('legacy numeric task links resolve only when the owner is unambiguous', () => {
  const tasks = groupIntoTasks([entry(101, null, 1, 1), entry(102, 500, 1, 3), entry(103, 500, 2, 5)], scoped);
  assert.equal(resolveTask(tasks, '101').key, '1:101');
  assert.equal(resolveTask(tasks, '500'), null);
  assert.equal(resolveTask(tasks, '1:500').user_id, 1);
  assert.equal(resolveTask(tasks, '2:500').user_id, 2);
  assert.equal(resolveTask(tasks, '999'), null);
});

test('application reports unify null-root resumes without changing the legacy helper contract', () => {
  const rows = [entry(101, null, 1, 1), entry(102, 101, 1, 3), entry(103, 101, 2, 5)];
  assert.equal(summarize(rows, { by: [] })[0].tasks, 3);
  assert.equal(summarize(rows, { by: [], ...scoped })[0].tasks, 2);
  assert.equal(summarize(rows, { by: [], ...scoped })[0].durationMs, 3 * 3600000);
  const now = new Date('2026-10-15T12:00:00Z').getTime();
  const continued = [entry(101, null, 1, 1, { end_reason: 'paused' }), entry(102, 101, 1, 3)];
  assert.equal(needsAttention(continued, now).length, 1);
  assert.deepEqual(needsAttention(continued, now, scoped), []);
});

test('application attention links include their owner and legacy links remain numeric', () => {
  const row = entry(101, null, 2, 1);
  assert.equal(taskHref(row), '#/?task=101');
  assert.equal(taskHref(row, scoped), '#/?task=2%3A101');
  assert.deepEqual(parseReportRoute('#/reports').by, ['agent', 'project', 'kind', 'repo']);
});
