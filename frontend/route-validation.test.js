import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, formatRoute } from './helpers.js';

test('dashboard date routes reject impossible dates and accept real leap days', () => {
  for (const date of ['bad', '', '2026-02-31', '2025-02-29', '2026-13-01', '2026-00-01', '2026-01-00', '0000-01-01']) assert.equal(parseRoute(`#/?date=${date}`).dateFilter, null);
  for (const date of ['2024-02-29', '2000-02-29', '0001-01-01', '0099-12-31', '9999-12-31']) assert.equal(parseRoute(`#/?date=${date}`).dateFilter, date);
});

test('only supported Timesheet ranges survive route parsing', () => {
  for (const range of ['day', 'week', 'month']) assert.equal(parseRoute(`#/?range=${range}`).range, range);
  for (const range of ['', 'bad', 'year', 'Day']) assert.equal(parseRoute(`#/?range=${range}`).range, 'week');
});

test('calendar week offsets are finite integers within one hundred years', () => {
  for (const week of ['Infinity', '-Infinity', '1e308', '0.5', '-0.5', 'bad', '5201', '-5201']) assert.equal(parseRoute(`#/calendar?week=${week}`).calendarWeekOffset, 0);
  for (const week of [-5200, -1, 0, 1, 5200]) assert.equal(parseRoute(`#/calendar?week=${week}`).calendarWeekOffset, week);
});

test('invalid dates and ranges retain independent filters and owner-scoped task links', () => {
  const route = parseRoute('#/?range=bad&date=bad&week=Infinity&project=4&repo=&kind=3&purpose=research&entity=2&task=2%3A101&q=review');
  assert.equal(route.range, 'week');
  assert.equal(route.dateFilter, null);
  assert.equal(route.calendarWeekOffset, 0);
  assert.equal(route.projectFilter, '4');
  assert.equal(route.repoFilter, '');
  assert.equal(route.kindFilter, '3');
  assert.equal(route.purposeFilter, 'research');
  assert.equal(route.modal, '2:101');
  assert.equal(parseRoute(formatRoute(route)).modal, '2:101');
});
