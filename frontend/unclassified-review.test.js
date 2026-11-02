import test from 'node:test';
import assert from 'node:assert/strict';
import { unclassifiedTasks } from './report-helpers.js';

const entry = (id, task_id, user_id, day, purpose = null, extra = {}) => ({
  id, task_id, user_id, project_id: 1, activity_id: 2, repo: 'tracker', purpose,
  description: `Task ${id}`, begin: `2026-10-${day}T10:00:00Z`, end: `2026-10-${day}T11:00:00Z`, ...extra,
});
const options = { from: '2026-10-12', to: '2026-10-14', ownerScoped: true };
const entries = [entry(101, null, 1, 12), entry(102, 101, 1, 13), entry(103, 101, 1, 15, 'support'),
  entry(201, 101, 2, 14), entry(301, 301, 1, 11), entry(401, 401, 1, 14, 'career')];

test('unclassified review counts owned tasks, joins null-root resumes and notes classified history', () => {
  assert.deepEqual(unclassifiedTasks(entries, options).map(({ entry, partiallyClassified }) => [entry.id, partiallyClassified]), [[201, false], [102, true]]);
  assert.deepEqual(unclassifiedTasks(entries, { ...options, agent: '1', project: '1', kind: '2', repo: '"tracker"', purpose: 'unclassified' }).map(row => row.entry.id), [102]);
  assert.deepEqual(unclassifiedTasks(entries, { ...options, purpose: 'support' }), []);
  assert.deepEqual(unclassifiedTasks(entries, { ...options, from: '2026-10-11', to: '2026-10-11' }).map(row => row.entry.id), [301]);
  assert.equal(unclassifiedTasks(entries, { ...options, ownerScoped: false }).length, 3);
  assert.equal(entries[2].purpose, 'support');
});

test('unclassified report inspection is opt-in, escaped, collapsed and explicitly bounded', async t => {
  const previous = globalThis.document;
  globalThis.document = { addEventListener() {} };
  t.after(() => { globalThis.document = previous; });
  const { renderReports } = await import('./reports.js');
  const now = new Date().toISOString();
  const rows = Array.from({ length: 27 }, (_, i) => ({ ...entry(i + 1, i + 1, 1, 12), begin: now, end: now, description: '<img src=x onerror=alert(1)>' }));
  const data = { entries: rows, users: [{ id: 1, label: 'Codex' }], projects: [{ id: 1, name: 'Tracker' }], activities: [{ id: 2, name: 'Implement' }] };
  assert.doesNotMatch(renderReports(data), /data-report-unclassified/);
  const html = renderReports(data, { includePurpose: true, ownerScoped: true });
  const review = html.match(/<details data-report-unclassified>[\s\S]*?<\/details>/)[0];
  assert.match(review, /27 tasks/);
  assert.match(review, /Showing 25 of 27/);
  assert.match(review, /Narrow the dates or filters/);
  assert.equal((review.match(/<a href=/g) || []).length, 25);
  assert.match(review, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(review, /<img| open/);
  assert.match(review, /Review the full task history/);
});
