import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('project management shows metadata and archives projects', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(app, /<th>Description<\/th>/);
  assert.match(app, /data-archive-project="\$\{p\.id\}"/);
  assert.match(app, /body:JSON\.stringify\(\{archived: !p\.archived\}\)/);
});

test('task project pickers exclude archived projects', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(app, /const activeProjects = \(\) => state\.projects\.filter\(p => !p\.archived\);/);
  assert.match(app, /activeProjects\(\)\.map\(p => `<option value="\$\{p\.id\}"/);
});
