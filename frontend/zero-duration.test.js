import test from 'node:test';
import assert from 'node:assert/strict';
import { clipEntriesToWindow, zeroDurationEntriesInWindow } from './helpers.js';

test('shared clipping still drops zero-length and boundary-touching segments', () => {
  const t = Date.UTC(2026, 9, 13, 12);
  const zero = { id: 1, user_id: 1, task_id: 1, begin: new Date(t).toISOString(), end: new Date(t).toISOString() };
  const touching = { id: 2, user_id: 1, task_id: 2, begin: new Date(t - 3600000).toISOString(), end: new Date(t).toISOString() };
  assert.deepEqual(clipEntriesToWindow([zero, touching], t, t + 86400000, t + 86400000), []);
});

test('zero-duration visibility uses parsed times and half-open window boundaries', () => {
  const from = Date.parse('2026-10-13T00:00:00Z'), to = from + 86400000;
  const lower = { begin: '2026-10-13T00:00:00Z', end: '2026-10-13T09:00:00+09:00' };
  const upper = { begin: '2026-10-14T00:00:00Z', end: '2026-10-14T00:00:00Z' };
  const before = { begin: '2026-10-12T23:59:59Z', end: '2026-10-12T23:59:59Z' };
  const inside = { begin: '2026-10-13T12:00:00Z', end: '2026-10-13T12:00:00Z' };
  const entries = [lower, upper, before, inside], original = structuredClone(entries);
  assert.deepEqual(zeroDurationEntriesInWindow(entries, from, to), [lower, inside]);
  assert.deepEqual(entries, original);
  assert.equal(zeroDurationEntriesInWindow(entries, from, to)[0], lower);
});

test('zero-duration visibility excludes open, positive and invalid intervals', () => {
  const from = Date.parse('2026-10-13T00:00:00Z'), to = from + 86400000;
  const begin = '2026-10-13T12:00:00Z';
  assert.deepEqual(zeroDurationEntriesInWindow([
    { begin, end: null },
    { begin, end: '2026-10-13T13:00:00Z' },
    { begin: 'invalid', end: 'invalid' },
    { begin, end: 'invalid' },
    { begin: 'invalid', end: begin },
  ], from, to), []);
});
