import test from 'node:test';
import assert from 'node:assert/strict';
import { idleGaps, longRunning, needsAttention, taskHref, toCsv, weekStart, weekValue } from './report-helpers.js';

const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString();
const now = new Date(2026, 9, 20, 12).getTime();

test('weekStart falls back to current Sunday on empty/malformed input', () => {
  const cur = weekStart('', now);
  assert.equal(cur.getDay(), 0);
  assert.equal(cur.getDate(), 18);
  for (const bad of ['abc', '2026-W99', '2026-W00', '2026W05', null, undefined, 7])
    assert.equal(weekStart(bad, now).getTime(), cur.getTime());
  const w = weekStart('2026-W42', now);
  assert.deepEqual([w.getFullYear(), w.getMonth(), w.getDate()], [2026, 9, 11]);
  for (const value of ['2026-W01', '2026-W53']) assert.equal(weekValue(weekStart(value)), value);
});

test('longRunning/needsAttention use only the latest segment per task', () => {
  const rows = [
    { id: 1, task_id: 7, begin: at(1, 8), end: at(1, 9), end_reason: 'paused' },
    { id: 2, task_id: 7, begin: at(2, 8), end: at(2, 9), end_reason: 'completed' },
    { id: 3, task_id: 8, begin: at(18, 8), end: at(18, 9), end_reason: 'auto' },
    { id: 4, task_id: 8, begin: at(19, 8), end: null },
    { id: 5, task_id: 9, begin: at(2, 8), end: at(2, 9), end_reason: 'paused' },
  ];
  for (const input of [rows, [...rows].reverse()]) {
    assert.deepEqual(longRunning(input, now).map(e => e.id).sort(), [4, 5]);
    assert.deepEqual(needsAttention(input, now).map(r => [r.entry.id, r.reason]).sort(),
      [[4, 'running >4h'], [5, 'paused >24h']]);
  }
});

test('latest task segment uses higher id to break matching begin times', () => {
  const rows = [
    { id: 2, task_id: 7, begin: at(1, 8), end: at(1, 9), end_reason: 'done' },
    { id: 1, task_id: 7, begin: at(1, 8), end: at(1, 9), end_reason: 'paused' },
  ];
  assert.deepEqual(needsAttention(rows, now), []);
});

test('open entry blocks false idle gap but not the real one before it', () => {
  const rows = [
    { user_id: 2, begin: at(5, 8), end: at(5, 9) },
    { user_id: 2, begin: at(5, 9, 30), end: null },
    { user_id: 2, begin: at(5, 11), end: at(5, 12) },
  ];
  const n = new Date(2026, 9, 5, 13).getTime();
  assert.deepEqual(idleGaps(rows, { now: n }).map(g => g.durationMs), [30 * 60000]);
});

test('idleGaps skips invalid intervals without Map.groupBy', () => {
  const rows = [
    { user_id: 2, begin: at(5, 8), end: at(5, 9) },
    { user_id: 2, begin: at(5, 9), end: 'invalid' },
    { user_id: 2, begin: 'invalid', end: at(5, 10) },
    { user_id: 2, begin: at(5, 10), end: at(5, 11) },
  ];
  const groupBy = Map.groupBy;
  try {
    Map.groupBy = undefined;
    assert.deepEqual(idleGaps(rows).map(g => g.durationMs), [3600000]);
  } finally { Map.groupBy = groupBy; }
});

test('taskHref encodes and falls back to id', () => {
  assert.equal(taskHref({ task_id: 7, id: 2 }), '#/?task=7');
  assert.equal(taskHref({ id: 5 }), '#/?task=5');
  assert.equal(taskHref({ task_id: '7"><script>' }), '#/?task=7%22%3E%3Cscript%3E');
});

test('toCsv neutralizes formula strings, keeps numbers', () => {
  assert.equal(
    toCsv(['a'], [['=SUM(A1)'], ['+1'], ['-1'], ['@x'], ['\tx'], [-1.5], [0], [null], ['ok=1']]),
    "a\r\n'=SUM(A1)\r\n'+1\r\n'-1\r\n'@x\r\n'\tx\r\n-1.5\r\n0\r\n\r\nok=1\r\n");
  assert.equal(toCsv(['=header'], [['\r=1']]), "'=header\r\n\"'\r=1\"\r\n");
});
