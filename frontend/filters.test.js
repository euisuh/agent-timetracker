import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, formatRoute, matchesRepoKind, repoOptions } from './helpers.js';

const task = (repo, activity_id) => ({ segments: [{ repo, activity_id }] });

test('repo and kind persist alongside existing route filters', () => {
  const state = { ...parseRoute('#/?project=3&entity=2&q=review'), repoFilter: 'api & "web"', kindFilter: '3' };
  assert.deepEqual(parseRoute(formatRoute(state)), state);
  assert.equal(formatRoute({ page: 'timesheet', repoFilter: 'api', kindFilter: '3' }), '#/?repo=api&kind=3');
});

test('default repo and kind add no route keys and emit no params', () => {
  const route = parseRoute('#/');
  assert.equal('repoFilter' in route, false);
  assert.equal('kindFilter' in route, false);
  assert.equal(formatRoute({ page: 'timesheet', repoFilter: null, kindFilter: undefined }), '#/');
});

test('empty repo selection round-trips distinctly from literal sentinel names', () => {
  for (const repo of ['', 'all', 'none', 'null', 'repo:', '<img src=x onerror=alert(1)>']) {
    const route = parseRoute(formatRoute({ page: 'timesheet', repoFilter: repo }));
    assert.equal(route.repoFilter, repo);
    assert.equal(matchesRepoKind(task(repo || null, 1), repo, null), true);
    assert.equal(matchesRepoKind(task('other', 1), repo, null), false);
  }
  assert.equal(formatRoute({ page: 'timesheet', repoFilter: '' }), '#/?repo=');
});

test('Unspecified repo matches absent values only; filters combine with AND', () => {
  assert.equal(matchesRepoKind(task(null, 3), '', '3'), true);
  assert.equal(matchesRepoKind(task(undefined, 3), '', '3'), true);
  assert.equal(matchesRepoKind(task('api', 3), '', '3'), false);
  assert.equal(matchesRepoKind(task('api', 3), 'api', '3'), true);
  assert.equal(matchesRepoKind(task('api', 2), 'api', '3'), false);
  assert.equal(matchesRepoKind(task('api', 3), null, null), true);
});

test('latest segment controls repo and kind; unknown selections match nothing', () => {
  const row = { segments: [{ repo: 'old', activity_id: 2 }, { repo: 'new', activity_id: 3 }] };
  assert.equal(matchesRepoKind(row, 'new', '3'), true);
  assert.equal(matchesRepoKind(row, 'old', '2'), false);
  assert.equal(matchesRepoKind(row, 'ghost', null), false);
  for (const kind of ['99', 'garbage', '<script>', '-1']) assert.equal(matchesRepoKind(row, null, kind), false);
});

test('repo choices are sorted unique latest values with missing repo omitted', () => {
  assert.deepEqual(repoOptions([task('b', 1), task('a', 1), task('b', 2), task(null, 1), task('', 1)]), ['a', 'b']);
});
