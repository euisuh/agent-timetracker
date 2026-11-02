import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRoute, parseRoute, purposeChoices, purposeLabel } from './helpers.js';
import { filterReportEntries, formatReportRoute, parseReportRoute, rawReportCsv, reportCoverage, summarize } from './report-helpers.js';

const entries = [
  { id: 1, task_id: 10, user_id: 1, project_id: 2, activity_id: 3, purpose: 'research', begin: '2026-10-13T01:00:00Z', end: '2026-10-13T02:00:00Z' },
  { id: 2, task_id: 10, user_id: 1, project_id: 2, activity_id: 3, purpose: 'research', begin: '2026-10-13T02:00:00Z', end: '2026-10-13T03:00:00Z' },
  { id: 3, task_id: 11, user_id: 1, project_id: 2, activity_id: 3, begin: '2026-10-13T03:00:00Z', end: '2026-10-13T04:00:00Z' },
];

test('purpose choices distinguish unknown intent from support', () => {
  assert.deepEqual(purposeChoices.map(([value]) => value), ['research', 'career', 'business', 'support']);
  assert.equal(purposeLabel(null), 'Unclassified');
  assert.equal(purposeLabel('support'), 'Support & life');
});

test('purpose filtering and grouping preserve unknown tasks and sum segments once', () => {
  assert.deepEqual(filterReportEntries(entries, { purpose: 'unclassified' }).map(entry => entry.id), [3]);
  assert.equal(filterReportEntries(entries, { purpose: 'research', project: '9' }).length, 0);
  const rows = summarize(entries, { by: ['purpose'], includePurpose: true });
  assert.equal(rows.find(row => row.purpose === 'research').tasks, 1);
  assert.equal(rows.find(row => row.purpose === null).tasks, 1);
  assert.equal(rows.reduce((sum, row) => sum + row.durationMs, 0), 3 * 3600000);
  assert.equal(reportCoverage(entries, { includePurpose: true }).unclassified, 1);
});

test('purpose exports append accepted intent without replacing original project or timing', () => {
  const csv = rawReportCsv(entries, { includePurpose: true });
  assert.match(csv.split('\r\n')[0], /project_id,activity_id/);
  assert.match(csv.split('\r\n')[0], /overlap_hours,purpose$/);
  assert.match(csv.split('\r\n')[1], /,1,research$/);
  assert.match(csv.split('\r\n')[3], /,1,$/);
});

test('purpose route filters round-trip and explicit legacy grouping survives a browser reload', () => {
  const route = parseRoute(formatRoute({ page: 'timesheet', purposeFilter: 'unclassified' }));
  assert.equal(route.purposeFilter, 'unclassified');
  const state = { ...parseReportRoute('#/reports'), purpose: 'research', by: ['purpose'] };
  assert.deepEqual(parseReportRoute(formatReportRoute(state)), state);
  const legacy = { ...state, by: ['agent', 'project', 'kind', 'repo'] };
  assert.ok(formatReportRoute(legacy, '', { includePurpose: true }).includes('report_by=agent%2Cproject%2Ckind%2Crepo'));
  assert.deepEqual(parseReportRoute(formatReportRoute(legacy, '', { includePurpose: true })).by, legacy.by);
});

test('report renderer opts into purpose defaults and exports while keeping context filters', async t => {
  const previousDocument = globalThis.document, previousLocation = globalThis.location;
  const previousCreate = URL.createObjectURL, previousRevoke = URL.revokeObjectURL;
  const listeners = new Map();
  let downloaded;
  globalThis.location = { hash: '#/reports?report_from=2026-10-13&report_to=2026-10-13' };
  globalThis.document = {
    addEventListener: (event, callback) => listeners.set(event, callback),
    querySelector: () => null,
    createElement: () => ({ click() {} }),
  };
  URL.createObjectURL = blob => { downloaded = blob; return 'blob:purpose-test'; };
  URL.revokeObjectURL = () => {};
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
  });
  const { renderReports } = await import('./reports.js');
  const html = renderReports({ entries, users: [{ id: 1, label: 'Codex' }], projects: [{ id: 2, name: 'Original project' }], activities: [{ id: 3, name: 'Implement' }] }, { includePurpose: true });
  assert.match(html, /data-report-by="purpose" type="checkbox" checked/);
  assert.doesNotMatch(html, /data-report-by="project" type="checkbox" checked/);
  assert.match(html, /1 with unclassified purpose/);
  assert.match(html, /Original project/);
  assert.match(html, /does not establish learning, research progress or income/);
  listeners.get('click')({ target: { matches: () => true, dataset: {} } });
  const csv = await downloaded.text();
  assert.match(csv, /^purpose,hours,tasks/);
  assert.match(csv, /Research,2,1/);
  assert.match(csv, /Unclassified,1,1/);
  globalThis.location.hash = '#/reports?report_project=2';
  const legacy = renderReports({ entries, users: [], projects: [], activities: [] }, { includePurpose: true });
  assert.match(legacy, /data-report-by="project" type="checkbox" checked/);
  assert.doesNotMatch(legacy, /data-report-by="purpose" type="checkbox" checked/);
  delete globalThis.location;
  const standalone = renderReports({ entries, users: [], projects: [], activities: [] }, { includePurpose: true });
  assert.match(standalone, /data-report-by="purpose" type="checkbox" checked/);
});
