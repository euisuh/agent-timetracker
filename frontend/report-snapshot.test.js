import test from 'node:test';
import assert from 'node:assert/strict';

test('exports retain the rendered report snapshot until the next render', async t => {
  const previous = globalThis.document;
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  const listeners = new Map();
  let downloaded;
  globalThis.document = {
    addEventListener: (event, handler) => listeners.set(event, handler),
    createElement: () => ({ click() {} }),
  };
  URL.createObjectURL = blob => { downloaded = blob; return 'blob:snapshot-test'; };
  URL.revokeObjectURL = () => {};
  t.after(() => {
    globalThis.document = previous;
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
  });
  const { renderReports } = await import('./reports.js');
  const entry = id => ({ id, task_id: id, user_id: 1, project_id: 1, activity_id: 1,
    description: `task-${id}`, begin: new Date(Date.now() - 7200000).toISOString(),
    end: new Date(Date.now() - 3600000).toISOString(), tokens_input: id });
  const state = { entries: [entry(1)], users: [{ id: 1, label: 'Original agent' }],
    projects: [{ id: 1, name: 'Original project' }], activities: [{ id: 1, name: 'implement' }] };
  renderReports(state);
  state.entries = [entry(2)];
  state.users = [{ id: 1, label: 'New agent' }];
  state.projects = [{ id: 1, name: 'New project' }];
  const exportCsv = async raw => {
    listeners.get('click')({ target: { matches: () => true, dataset: raw ? { reportRawCsv: '' } : {} } });
    return downloaded.text();
  };
  assert.match(await exportCsv(true), /task-1/);
  assert.doesNotMatch(await exportCsv(true), /task-2/);
  assert.match(await exportCsv(false), /Original agent,Original project/);
  renderReports(state);
  assert.match(await exportCsv(true), /task-2/);
  assert.doesNotMatch(await exportCsv(true), /task-1/);
  assert.match(await exportCsv(false), /New agent,New project/);
});
