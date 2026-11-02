import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute } from './helpers.js';

test('invalid purpose URLs fall back to the visible All filter', () => {
  for (const value of ['typo', 'Research', 'null', '']) {
    assert.equal(parseRoute(`#/?purpose=${value}`).purposeFilter, undefined);
  }
  for (const value of ['research', 'career', 'business', 'support', 'unclassified']) {
    assert.equal(parseRoute(`#/?purpose=${value}`).purposeFilter, value);
  }
});

test('standalone report callers regain legacy grouping after purpose mode', async t => {
  const originalDocument = globalThis.document, originalLocation = globalThis.location;
  globalThis.document = { addEventListener() {} };
  delete globalThis.location;
  t.after(() => {
    globalThis.document = originalDocument;
    globalThis.location = originalLocation;
  });
  const { renderReports } = await import('./reports.js');
  const data = { entries: [], users: [], projects: [], activities: [] };
  const first = renderReports(data);
  assert.match(first, /data-report-by="project" type="checkbox" checked/);
  const purpose = renderReports(data, { includePurpose: true });
  assert.match(purpose, /data-report-by="purpose" type="checkbox" checked/);
  const restored = renderReports(data);
  assert.match(restored, /data-report-by="project" type="checkbox" checked/);
  assert.doesNotMatch(restored, /data-report-by="purpose" type="checkbox" checked/);
});
