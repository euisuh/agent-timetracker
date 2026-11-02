import test from 'node:test';
import assert from 'node:assert/strict';
import { groupIntoTasks, taskDurationMs, groupByDay, groupTasksByDay, activityGridWeeks, dayKey, splitEntities, startOfWeek, taskKey, clipToDay, packColumns, agentActivity, formatRoute, parseRoute, stableColorById, hoursByKindEntity, sevenDayHoursByAgent, taskStatus, liveTasks, taskMeta, matchesSearch } from './helpers.js';

const task = (last = {}) => ({
  description: 'Fix dashboard',
  segments: [{ begin: '2026-10-04T00:00:00Z', end: '2026-10-04T01:00:00Z', ...last }],
});

test('taskStatus distinguishes running, paused, auto-closed, and completed tasks', () => {
  assert.equal(taskStatus(task({ end: null })), 'running');
  assert.equal(taskStatus(task({ end_reason: 'paused' })), 'paused');
  assert.equal(taskStatus(task({ end_reason: 'auto' })), 'auto');
  assert.equal(taskStatus(task({ end_reason: 'done' })), 'completed');
});

test('liveTasks keeps running and recent paused tasks, excluding paused tasks over 24 hours old', () => {
  const now = new Date('2026-10-05T12:00:00Z').getTime();
  const running = task({ begin: '2026-10-05T11:00:00Z', end: null });
  const recentPaused = task({ end: '2026-10-04T12:00:00Z', end_reason: 'paused' });
  const oldPaused = task({ end: '2026-10-04T11:59:59Z', end_reason: 'paused' });
  assert.deepEqual(liveTasks([running, recentPaused, oldPaused], now), [running, recentPaused]);
});

test('taskMeta includes entity, project, non-default kind, and repo', () => {
  assert.deepEqual(taskMeta(task({ repo: 'dashboard' }), 'Codex', 'timetracker', 'implement'), ['Codex', 'timetracker', 'implement', 'dashboard']);
  assert.deepEqual(taskMeta(task({ repo: 'dashboard' }), 'Codex', 'timetracker', 'Assigned Task'), ['Codex', 'timetracker', 'dashboard']);
});

test('matchesSearch includes description, kind, and repo', () => {
  const meta = taskMeta(task({ repo: 'dashboard' }), 'Codex', 'timetracker', 'implement');
  assert.equal(matchesSearch(task(), 'fix', meta), true);
  assert.equal(matchesSearch(task(), 'implement', meta), true);
  assert.equal(matchesSearch(task(), 'dashboard', meta), true);
  assert.equal(matchesSearch(task(), 'research', meta), false);
});

test('route round-trips all view state', () => {
  const state = {
    page: 'calendar', range: 'month', projectFilter: '3', entityFilter: new Set([2, 4]), search: 'fix & ship',
    calendarWeekOffset: -1, dateFilter: '2026-10-05', modal: '2::3::Fix router',
  };
  assert.deepEqual(parseRoute(formatRoute(state)), state);
});

test('route aliases normalize and unknown routes render not-found', () => {
  assert.equal(parseRoute('#/management').page, 'projects');
  assert.equal(parseRoute('#/recommended').page, 'favorites');
  assert.equal(parseRoute('#/reports').page, 'reports');
  assert.equal(parseRoute('#/missing').page, 'not-found');
});

test('agentActivity splits working vs idle and counts agents per project once', () => {
  const entries = [
    { user_id: 2, project_id: 1, description: 'a', begin: '2026-01-01T10:00:00Z', end: null },
    { user_id: 2, project_id: 1, description: 'b', begin: '2026-01-01T11:00:00Z', end: null },
    { user_id: 2, project_id: 3, description: 'c', begin: '2026-01-01T09:00:00Z', end: null },
    { user_id: 3, project_id: 1, description: 'd', begin: '2026-01-01T08:00:00Z', end: null },
    { user_id: 4, project_id: 3, description: 'e', begin: '2026-01-01T07:00:00Z', end: '2026-01-01T08:00:00Z' },
    { user_id: 4, project_id: 1, description: 'f', begin: '2026-01-01T09:00:00Z', end: '2026-01-01T09:30:00Z' },
  ];
  const r = agentActivity(entries, [2, 3, 4, 5]);
  assert.deepEqual(r.agents.map(a => [a.id, a.working]), [[2, true], [3, true], [4, false]]);
  assert.equal(r.working, 2);
  assert.equal(r.idle, 1);
  assert.deepEqual(r.perProject, [[1, 2], [3, 1]]);
  assert.deepEqual(r.agents[0].projectIds, [1, 3]);
  assert.equal(r.agents[2].last.description, 'f');
});

test('groups pause/resume segments and totals duration', () => {
  const entries = [
    { task_id: 1, user_id: 1, project_id: 2, description: 'Task', begin: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' },
    { task_id: 1, user_id: 1, project_id: 2, description: 'Task', begin: '2026-01-01T02:00:00Z', end: null },
  ];
  const [task] = groupIntoTasks(entries);
  assert.equal(task.segments.length, 2);
  assert.equal(task.isRunning, true);
  assert.equal(taskDurationMs(task, new Date('2026-01-01T03:00:00Z').getTime()), 7200000);
});

test('groupByDay sums ms per local day, optionally filtered by user', () => {
  // Local-time fixtures: the grouping is per LOCAL day, so UTC literals would land on different
  // days depending on the machine's timezone.
  const at = (day, hour, minute = 0) => new Date(2026, 0, day, hour, minute);
  const entries = [
    { user_id: 1, begin: at(1, 10).toISOString(), end: at(1, 11).toISOString() },
    { user_id: 1, begin: at(1, 12).toISOString(), end: at(1, 12, 30).toISOString() },
    { user_id: 2, begin: at(3, 13).toISOString(), end: at(3, 14).toISOString() },
    { user_id: 1, begin: at(2, 0).toISOString(), end: at(2, 0, 10).toISOString() },
  ];
  const all = groupByDay(entries);
  assert.equal(all.get(dayKey(at(1, 10))), 5400000);
  assert.equal(all.get(dayKey(at(2, 0))), 600000);

  const user1Only = groupByDay(entries, 1);
  assert.equal(user1Only.get(dayKey(at(1, 10))), 5400000);
  assert.equal(user1Only.has(dayKey(at(2, 0))), true);
  const totalUser1 = [...user1Only.values()].reduce((a, b) => a + b, 0);
  assert.equal(totalUser1, 6000000);
});

test('activityGridWeeks builds Sunday-start week columns ending on the given date, no future days', () => {
  const end = new Date('2026-08-05T12:00:00'); // Wednesday, local time
  const weeks = activityGridWeeks(end);
  assert.equal(weeks.every(w => w.length === 7), true);
  const lastWeek = weeks.at(-1);
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  assert.equal(lastWeek[endDay.getDay()].getTime(), endDay.getTime());
  for (let i = endDay.getDay() + 1; i < 7; i++) assert.equal(lastWeek[i], null);
  const firstWeek = weeks[0];
  assert.equal(firstWeek[0].getDay(), 0);
  const span = (endDay - firstWeek[0]) / 86400000;
  assert.ok(span >= 364 && span < 371, `expected span in [364,371), got ${span}`);
});

test('startOfWeek returns the Sunday on/before the given date, at local midnight', () => {
  const wed = new Date('2026-08-05T15:30:00');
  const sunday = startOfWeek(wed);
  assert.equal(sunday.getDay(), 0);
  assert.equal(sunday.getHours(), 0);
  assert.equal(sunday.getMinutes(), 0);
  assert.ok(sunday.getTime() <= wed.getTime());
  assert.ok((wed.getTime() - sunday.getTime()) / 86400000 < 7);
});

test('groups same-description entries by server task identity', () => {
  const entries = [
    { task_id: 10, user_id: 1, project_id: 2, description: 'Task', begin: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' },
    { task_id: 11, user_id: 1, project_id: 2, description: 'Task', begin: '2026-01-01T02:00:00Z', end: '2026-01-01T03:00:00Z' },
  ];
  const tasks = groupIntoTasks(entries);
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map(t => t.key), ['11', '10']);
  assert.equal(taskKey(entries[0]), '10');
});

test('clipToDay clips a segment crossing midnight to the requested day only', () => {
  const day = new Date(2026, 0, 2);
  const clipped = clipToDay({ begin: '2026-01-01T22:00:00', end: '2026-01-02T02:00:00' }, day);
  assert.ok(clipped);
  assert.equal(clipped.startMin, 0);
  assert.equal(clipped.endMin, 120);
});

test('clipToDay returns null when the entry does not overlap the given day', () => {
  const day = new Date(2026, 0, 2);
  const clipped = clipToDay({ begin: '2026-01-03T10:00:00', end: '2026-01-03T11:00:00' }, day);
  assert.equal(clipped, null);
});

test('clipToDay clips a still-running entry (end: null) to "now" for positioning', () => {
  const day = new Date(2026, 0, 5);
  const now = new Date(2026, 0, 5, 10, 30).getTime();
  const clipped = clipToDay({ begin: '2026-01-05T09:00:00', end: null }, day, now);
  assert.ok(clipped);
  assert.equal(clipped.startMin, 540);
  assert.equal(clipped.endMin, 630);
});

test('packColumns assigns non-overlapping columns and reuses freed columns', () => {
  const blocks = [
    { startMin: 0, endMin: 60 },
    { startMin: 30, endMin: 90 },
    { startMin: 70, endMin: 100 },
  ];
  const { blocks: packed, maxColumns } = packColumns(blocks);
  assert.equal(maxColumns, 2);
  const byStart = [...packed].sort((a, b) => a.startMin - b.startMin);
  assert.equal(byStart[0].col, 0);
  assert.equal(byStart[1].col, 1);
  assert.equal(byStart[2].col, 0);
});

test('groupTasksByDay sections tasks by local start day, newest section first', () => {
  const tasks = [
    { key: 'a', firstBegin: new Date(2026, 7, 6, 19, 8).toISOString() },
    { key: 'b', firstBegin: new Date(2026, 7, 6, 9, 0).toISOString() },
    { key: 'c', firstBegin: new Date(2026, 7, 5, 23, 30).toISOString() },
  ];
  const groups = groupTasksByDay(tasks);
  assert.deepEqual(groups.map(([key, list]) => [key, list.map(t => t.key)]), [
    ['2026-08-06', ['a', 'b']],
    ['2026-08-05', ['c']],
  ]);
});

test('splitEntities keeps featured tiles in order and buckets everyone else', () => {
  const perEntity = [
    { username: 'admin', ms: 0 },
    { username: 'agent-codex', ms: 60 },
    { username: 'agent-claude-code', ms: 120 },
    { username: 'agent-hermes', ms: 5 },
    { username: 'agent-future', ms: 7 },
  ];
  const { featured, rest } = splitEntities(perEntity, ['admin', 'agent-claude-code', 'agent-codex']);
  assert.deepEqual(featured.map(u => u.username), ['admin', 'agent-claude-code', 'agent-codex']);
  assert.deepEqual(rest.map(u => u.username), ['agent-hermes', 'agent-future']);
  assert.equal(rest.reduce((n, u) => n + u.ms, 0), 12);
});

test('splitEntities skips a featured entity that does not exist yet', () => {
  const { featured } = splitEntities([{ username: 'admin', ms: 0 }], ['admin', 'agent-codex']);
  assert.deepEqual(featured.map(u => u.username), ['admin']);
});

test('stableColorById uses id modulo palette length, not input order', () => {
  const palette = ['first', 'second', 'third'];
  assert.equal(stableColorById(4, palette), 'second');
  assert.equal(stableColorById(7, palette), 'second');
});

test('hoursByKindEntity totals entries by activity and agent', () => {
  const entries = [
    { activity_id: 1, user_id: 2, begin: '2026-10-05T09:00:00Z', end: '2026-10-05T10:30:00Z' },
    { activity_id: 1, user_id: 3, begin: '2026-10-05T10:00:00Z', end: '2026-10-05T10:30:00Z' },
    { activity_id: 2, user_id: 2, begin: '2026-10-05T11:00:00Z', end: '2026-10-05T13:00:00Z' },
  ];
  assert.deepEqual(hoursByKindEntity(entries, [1, 2], [2, 3]), [
    { activityId: 1, entities: [{ id: 2, hours: 1.5 }, { id: 3, hours: 0.5 }], hours: 2 },
    { activityId: 2, entities: [{ id: 2, hours: 2 }, { id: 3, hours: 0 }], hours: 2 },
  ]);
});

test('sevenDayHoursByAgent includes segments overlapping prior seven days', () => {
  const now = new Date('2026-10-08T12:00:00Z').getTime();
  const entries = [
    { user_id: 2, begin: '2026-10-01T10:00:00Z', end: '2026-10-01T12:00:00Z' },
    { user_id: 2, begin: '2026-10-07T10:00:00Z', end: '2026-10-07T11:30:00Z' },
    { user_id: 3, begin: '2026-09-30T10:00:00Z', end: '2026-10-01T13:00:00Z' },
  ];
  assert.deepEqual(sevenDayHoursByAgent(entries, [2, 3], now), new Map([[2, 1.5], [3, 1]]));
});

test('taskMeta omits a repo that repeats the project name', () => {
  const task = repo => ({ segments: [{ repo }] });
  assert.deepEqual(taskMeta(task('timetracker'), 'Claude', 'timetracker', 'review'), ['Claude', 'timetracker', 'review']);
  assert.deepEqual(taskMeta(task('other-repo'), 'Claude', 'timetracker', 'Assigned Task'), ['Claude', 'timetracker', 'other-repo']);
});
