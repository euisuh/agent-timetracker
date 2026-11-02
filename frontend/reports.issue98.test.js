import test from 'node:test';
import assert from 'node:assert/strict';
import { weekStart, weekValue } from './report-helpers.js';

test('report week change updates rendered rows and CSV, clearing restores this week', async t => {
  const listeners = new Map(), report = { outerHTML: '' };
  const previousDocument = globalThis.document;
  const createObjectURL = URL.createObjectURL, revokeObjectURL = URL.revokeObjectURL;
  let downloaded;
  globalThis.document = {
    addEventListener: (event, handler) => listeners.set(event, handler),
    querySelector: () => report,
    createElement: () => ({ click() {} }),
  };
  URL.createObjectURL = blob => { downloaded = blob; return 'blob:report-test'; };
  URL.revokeObjectURL = () => {};
  t.after(() => {
    globalThis.document = previousDocument;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });
  const { renderReports } = await import('./reports.js');
  const entry = (id, month, tokens) => ({
    id, task_id: id, user_id: 1, project_id: 1, activity_id: 1,
    begin: new Date(2026, month, 1, 9).toISOString(),
    end: new Date(2026, month, 1, 10).toISOString(), tokens_input: tokens,
  });
  report.outerHTML = renderReports({
    entries: [entry(1, 0, 111), entry(2, 9, 222), {
      id: 3, task_id: 30, user_id: 1, description: 'Fix <unsafe> text',
      begin: new Date(Date.now() - 48 * 3600000).toISOString(),
      end: new Date(Date.now() - 47 * 3600000).toISOString(), end_reason: 'paused',
    }],
    users: [{ id: 1, label: 'Agent' }], projects: [{ id: 1, name: 'Project' }],
    activities: [{ id: 1, name: 'implement' }],
  });
  assert.match(report.outerHTML, /href="#\/\?task=30">Fix &lt;unsafe&gt; text<\/a>/);
  const changeWeek = value => listeners.get('change')({ target: {
    matches: () => true, dataset: { reportWeek: '' }, value,
  } });
  changeWeek('2026-W01');
  assert.match(report.outerHTML, /value="2026-W01"/);
  assert.match(report.outerHTML, /111 \(111\/0\/0\)/);
  listeners.get('click')({ target: { matches: () => true } });
  const csv = await downloaded.text();
  assert.match(csv, /Agent,Project,implement,—,1,1,111,111,0,0,60,111/);
  assert.doesNotMatch(csv, /222/);
  changeWeek('');
  assert.ok(report.outerHTML.includes(`value="${weekValue(weekStart())}"`));
  changeWeek('malformed');
  assert.ok(report.outerHTML.includes(`value="${weekValue(weekStart())}"`));
});
