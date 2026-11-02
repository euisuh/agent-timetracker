import test from 'node:test';
import assert from 'node:assert/strict';
import { filterReportEntries, formatReportRoute, needsAttention, overlapDurationMs, parseReportRoute, rawReportCsv, reportCoverage, reportRange, summarize, weeklySeries } from './report-helpers.js';

const hour = 3600000;
const at = (day, hours = 0) => new Date(2026, 9, day, hours).toISOString();
const entry = (id, values = {}) => ({ id, task_id: id, user_id: 1, project_id: 2, activity_id: 3, repo: 'alpha', begin: at(5, 9), end: at(5, 10), ...values });

test('report dimension filters combine and missing repositories cannot collide with names', () => {
  const entries = [entry(1), entry(2, { user_id: 2 }), entry(3, { project_id: 9 }), entry(4, { activity_id: 7 }), entry(5, { repo: null }), entry(6, { repo: 'null' })];
  assert.deepEqual(filterReportEntries(entries, { agent: '1', project: '2', kind: '3', repo: JSON.stringify('alpha') }).map(e => e.id), [1]);
  assert.deepEqual(filterReportEntries(entries, { repo: 'null' }).map(e => e.id), [5]);
  assert.deepEqual(filterReportEntries(entries, { repo: JSON.stringify('null') }).map(e => e.id), [6]);
  assert.deepEqual(filterReportEntries(entries, { agent: '999' }), []);
  assert.equal(summarize([entry(1, { repo: null }), entry(2, { repo: '—' })], { by: ['repo'] }).length, 2);
});

test('report dates default individually to the selected week and invalid ranges are rejected', () => {
  assert.deepEqual(reportRange({ week: '2026-W42' }), { from: '2026-10-11', to: '2026-10-17', error: '' });
  assert.deepEqual(reportRange({ week: '2026-W42', from: '2026-10-12' }), { from: '2026-10-12', to: '2026-10-17', error: '' });
  assert.match(reportRange({ from: '2026-02-30', to: '2026-10-17' }).error, /valid/);
  assert.match(reportRange({ from: '2026-10-17', to: '2026-10-12' }).error, /before|after/);
  assert.deepEqual(filterReportEntries([entry(1)], { from: 'invalid', to: '2026-10-17' }), []);
});

test('summary clips overlapping midnight segments and attributes tokens only to their begin date', () => {
  const segment = entry(1, { begin: at(4, 23), end: at(5, 1), tokens_input: 100, tokens_output: 20 });
  const previous = summarize([segment], { from: '2026-10-04', to: '2026-10-04' })[0];
  const current = summarize([segment], { from: '2026-10-05', to: '2026-10-05' })[0];
  assert.equal(previous.durationMs, hour);
  assert.equal(current.durationMs, hour);
  assert.equal(previous.tokens, 120);
  assert.equal(current.tokens, 0);
  assert.equal(current.tasks, 1);
  assert.equal(current.medianDurationMs, hour);
  assert.equal(current.medianTokens, 0);
  assert.equal(segment.begin, at(4, 23));
  assert.deepEqual(filterReportEntries([entry(2, { begin: at(4, 22), end: at(5) })], { from: '2026-10-05', to: '2026-10-05' }), []);
});

test('weekly trend splits a segment at Sunday and honors optional date clipping', () => {
  const segment = entry(1, { begin: at(10, 23), end: at(11, 1) });
  const options = { end: new Date(2026, 9, 17), weeks: 2 };
  assert.deepEqual(weeklySeries([segment], options)[0].weeks.map(w => w.durationMs), [hour, hour]);
  assert.deepEqual(weeklySeries([segment], { ...options, from: '2026-10-11', to: '2026-10-17' })[0].weeks.map(w => w.durationMs), [0, hour]);
});

test('open work clips to injected now and multi-segment task medians use selected overlap', () => {
  const entries = [entry(1, { task_id: 10, begin: at(4, 23), end: at(5, 1) }), entry(2, { task_id: 10, begin: at(5, 2), end: null })];
  const options = { from: '2026-10-05', to: '2026-10-05', now: new Date(2026, 9, 5, 3).getTime() };
  const summary = summarize(entries, options)[0];
  assert.equal(summary.tasks, 1);
  assert.equal(summary.durationMs, 2 * hour);
  assert.equal(summary.medianDurationMs, 2 * hour);
  assert.equal(overlapDurationMs(entries[1], options), hour);
});

test('local day clipping respects 23-hour and 25-hour daylight saving days', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    for (const [month, day, hours] of [[2, 8, 23], [10, 1, 25]]) {
      const begin = new Date(2026, month, day), end = new Date(2026, month, day + 1);
      const segment = entry(1, { begin: begin.toISOString(), end: end.toISOString() });
      assert.equal(summarize([segment], { from: begin, to: begin })[0].durationMs, hours * hour);
      assert.equal(weeklySeries([segment], { end: begin, weeks: 1 })[0].weeks[0].durationMs, hours * hour);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('coverage separates absent token counters, partial counters, and zero recorded tokens', () => {
  const zero = { tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0 };
  assert.deepEqual(reportCoverage([entry(1, { repo: null }), entry(2, zero), entry(3, { tokens_input: 0 }), entry(4, { ...zero, tokens_output: 1 })]), {
    segments: 4, missingRepo: 1, recordedTokens: 3, missingTokens: 1, partialTokens: 1, zeroTokens: 2,
  });
  assert.equal(reportCoverage([]).segments, 0);
  const previousDay = entry(1, { begin: at(4, 23), end: at(5, 1), tokens_input: 100 });
  assert.equal(reportCoverage([previousDay], { from: '2026-10-05', to: '2026-10-05' }).recordedTokens, 0);
});

test('report query round-trips filters, dates, week, empty groups, and special repository names', () => {
  const state = { week: '2026-W42', from: '2026-10-01', to: '2026-10-17', agent: '1', project: '2', kind: '3', repo: JSON.stringify('null & =report'), by: [] };
  assert.deepEqual(parseReportRoute(formatReportRoute(state)), state);
  assert.deepEqual(parseReportRoute('#/reports').by, ['agent', 'project', 'kind', 'repo']);
  assert.deepEqual(parseReportRoute('#/reports?report_by=agent,invalid,agent').by, ['agent']);
  assert.ok(formatReportRoute(state, '#/reports?range=month').includes('range=month'));
});

test('raw CSV keeps original segment values and exports only matching overlaps', () => {
  const segment = entry(1, { description: '=formula', repo: null, begin: at(4, 23), end: at(5, 1), end_reason: 'paused', tokens_input: 100 });
  const csv = rawReportCsv([segment, entry(2, { user_id: 2 })], { agent: '1', from: '2026-10-05', to: '2026-10-05' });
  assert.match(csv, /id,task_id,user_id,project_id,activity_id,repo,description,begin,end,end_reason,auto_closed,tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,tokens_cache_write,overlap_hours/);
  assert.ok(csv.includes(`1,1,1,2,3,,'=formula,${segment.begin},${segment.end},paused,,100,,,,,1`));
  assert.equal(csv.trim().split('\r\n').length, 2);
  assert.equal(segment.tokens_input, 100);
});

test('task counts and attention distinguish owners and legacy entry identifiers', () => {
  const rows = [entry(1, { task_id: 9 }), entry(2, { user_id: 2, task_id: 9 }), entry(9, { task_id: null })];
  assert.equal(summarize(rows, { by: [] })[0].tasks, 3);
  const current = new Date(2026, 9, 10).getTime();
  const paused = rows.map(row => ({ ...row, end_reason: 'paused' }));
  const completed = entry(10, { task_id: 9, begin: at(6, 9), end: at(6, 10), end_reason: 'done' });
  assert.deepEqual(needsAttention([...paused, completed], current).map(row => row.entry.id).sort((a, b) => a - b), [2, 9]);
});

test('attention applies dimensions to current metadata before limiting auto-closed tasks', () => {
  const rows = Array.from({ length: 26 }, (_, index) => entry(index + 1, {
    project_id: index === 0 ? 99 : 1, begin: at(5, 1), end: new Date(2026, 9, 5, 2, index).toISOString(), end_reason: 'auto',
  }));
  const current = new Date(2026, 9, 6).getTime();
  assert.deepEqual(needsAttention(rows, current, { project: '99' }).map(row => row.entry.id), [1]);
  assert.deepEqual(needsAttention([...rows, entry(27, { task_id: 1, project_id: 1, begin: at(5, 3), end: at(5, 4), end_reason: 'done' })], current, { project: '99' }), []);
});

test('token medians use recorded tasks without converting absent counters to measured zero', () => {
  const rows = [entry(1), entry(2, { tokens_input: 100 })];
  assert.equal(summarize(rows, { by: [] })[0].medianTokens, 100);
  assert.equal(summarize([...rows, entry(3, { tokens_input: 0 })], { by: [] })[0].medianTokens, 50);
});


test('coverage distinguishes older overlapping counters from exclusive counters', async t => {
  const originalDocument = globalThis.document, originalLocation = globalThis.location;
  globalThis.document = { addEventListener() {} };
  delete globalThis.location;
  t.after(() => {
    globalThis.document = originalDocument;
    globalThis.location = originalLocation;
  });
  const { renderReports } = await import('./reports.js');
  const html = renderReports({ entries: [], users: [], projects: [], activities: [] });
  const coverage = html.match(/<div[^>]*data-report-coverage>[\s\S]*?<\/div>/)[0];
  assert.match(coverage, /may overlap input and output/);
  assert.match(coverage, /exclusive counter format/);
  assert.doesNotMatch(coverage, /counters overlap input/);
});
