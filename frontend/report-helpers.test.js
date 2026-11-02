import test from 'node:test';
import assert from 'node:assert/strict';
import { idleGaps, longRunning, needsAttention, summarize, toCsv, weeklySeries } from './report-helpers.js';

const hour = 3600000;
const stamp = (year, month, day, hours, minutes = 0) => new Date(year, month - 1, day, hours, minutes).toISOString();
const entries = [
  { id: 1, task_id: 1, user_id: 2, project_id: 3, activity_id: 4, repo: 'alpha', begin: stamp(2026, 10, 5, 9), end: stamp(2026, 10, 5, 10), tokens_input: 100, tokens_output: 20, tokens_cache_read: 30, tokens_cache_write: 4 },
  { id: 2, task_id: 1, user_id: 2, project_id: 3, activity_id: 4, repo: 'alpha', begin: stamp(2026, 10, 5, 11), end: stamp(2026, 10, 5, 11, 30), tokens_input: 50, tokens_output: 10, tokens_cache_read: 6, tokens_cache_write: 0 },
  { id: 3, task_id: 2, user_id: 2, project_id: 5, activity_id: 6, repo: 'beta', begin: stamp(2026, 10, 6, 9), end: stamp(2026, 10, 6, 11), tokens_input: 200, tokens_output: 40, tokens_cache_read: 0, tokens_cache_write: 0 },
  { id: 4, task_id: 3, user_id: 3, project_id: 3, activity_id: 4, repo: 'alpha', begin: stamp(2026, 9, 28, 9), end: stamp(2026, 9, 28, 10), tokens_input: 5, tokens_output: 5, tokens_cache_read: 0, tokens_cache_write: 0 },
];

test('summarize groups tasks, durations and token slices', () => {
  const rows = summarize(entries, { by: ['agent', 'project'], from: new Date(2026, 9, 5), to: new Date(2026, 9, 11) });
  assert.deepEqual(rows.map(row => [row.agent, row.project, row.tasks, row.durationMs, row.tokens, row.input, row.output, row.cache, row.medianDurationMs, row.medianTokens]), [
    [2, 3, 1, 90 * 60000, 220, 150, 30, 40, 90 * 60000, 220],
    [2, 5, 1, 2 * hour, 240, 200, 40, 0, 2 * hour, 240],
  ]);
});

test('weeklySeries returns Sunday weeks per kind', () => {
  const rows = weeklySeries(entries, { end: new Date(2026, 9, 7, 12), weeks: 2 });
  assert.deepEqual(rows.map(row => [row.activity_id, row.weeks.map(week => week.durationMs)]), [[4, [hour, 90 * 60000]], [6, [0, 2 * hour]]]);
});

test('summarize and weeklySeries include running time through injected now', () => {
  const begin = new Date(2026, 9, 4, 1);
  const now = new Date(2026, 9, 4, 3).getTime();
  const running = [{ id: 9, task_id: 9, user_id: 2, project_id: 3, activity_id: 4, begin: begin.toISOString(), end: null }];
  assert.equal(summarize(running, { from: new Date(2026, 9, 4), to: new Date(2026, 9, 10), now }).at(0).durationMs, 2 * hour);
  assert.deepEqual(weeklySeries(running, { end: new Date(2026, 9, 7, 12), weeks: 1, now }).at(0).weeks.map(week => week.durationMs), [2 * hour]);
});

test('weeklySeries uses local Sunday-start weeks', () => {
  const sunday = new Date(2026, 9, 4, 1);
  const rows = weeklySeries([{ id: 9, activity_id: 4, begin: sunday.toISOString(), end: new Date(2026, 9, 4, 2).toISOString() }], { end: new Date(2026, 9, 10, 12), weeks: 1 });
  assert.equal(rows.at(0).weeks.at(0).start, '2026-10-04');
  assert.equal(rows.at(0).weeks.at(0).durationMs, hour);
});

test('idleGaps detects time between an agent’s segments', () => {
  assert.deepEqual(idleGaps(entries).map(gap => [gap.user_id, gap.durationMs]), [[2, 60 * 60000], [2, 21.5 * hour]]);
});

test('idleGaps limits gaps to range and duration bounds', () => {
  const day = (hour, minute = 0) => stamp(2026, 10, 5, hour, minute);
  const rows = [
    { user_id: 2, begin: day(8), end: day(9) },
    { user_id: 2, begin: day(9, 10), end: day(10) },
    { user_id: 2, begin: day(11), end: day(12) },
    { user_id: 2, begin: day(21), end: day(22) },
  ];
  assert.deepEqual(idleGaps(rows, { from: new Date(2026, 9, 5), to: new Date(2026, 9, 5, 23, 59), minMs: 15 * 60000, maxMs: 8 * hour }).map(gap => gap.durationMs), [hour]);
});

test('longRunning flags old running and paused entries', () => {
  const now = new Date(2026, 9, 7, 12).getTime();
  const flagged = longRunning([
    { id: 1, begin: stamp(2026, 10, 7, 7), end: null },
    { id: 2, begin: stamp(2026, 10, 6, 8), end: stamp(2026, 10, 6, 9), end_reason: 'paused' },
    { id: 3, begin: stamp(2026, 10, 7, 9), end: null },
  ], now);
  assert.deepEqual(flagged.map(entry => entry.id), [1, 2]);
});

test('needsAttention keeps recent auto-closed entries, newest first, capped at 25', () => {
  const now = new Date(2026, 9, 20, 12).getTime();
  const recent = Array.from({ length: 26 }, (_, index) => ({ id: index + 1, begin: stamp(2026, 10, 19, 0), end: stamp(2026, 10, 19, 0, index), end_reason: 'auto' }));
  const rows = needsAttention([...recent, { id: 99, begin: stamp(2026, 9, 1, 0), end: stamp(2026, 9, 1, 1), end_reason: 'auto' }], now);
  assert.deepEqual(rows.map(row => row.entry.id), Array.from({ length: 25 }, (_, index) => 26 - index));
});

test('toCsv escapes commas, quotes and newlines', () => {
  assert.equal(toCsv(['Agent', 'Task'], [['Codex', 'Fix, "quotes"\nand newline']]), 'Agent,Task\r\nCodex,"Fix, ""quotes""\nand newline"\r\n');
});
