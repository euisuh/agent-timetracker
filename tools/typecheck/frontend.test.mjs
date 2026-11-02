import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('the production typecheck rejects bad properties in every newly covered browser module', t => {
  const dir = mkdtempSync(join(tmpdir(), 'timetracker-frontend-types-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'frontend'));
  for (const file of ['package.json', 'tsconfig.helpers.json', 'tsconfig.frontend.json', 'frontend/package.json', 'frontend/app.js', 'frontend/helpers.js', 'frontend/reports.js', 'frontend/report-helpers.js']) {
    cpSync(join(source, file), join(dir, file));
  }
  symlinkSync(join(source, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const compile = () => spawnSync('npm', ['run', 'typecheck', '--', '--pretty', 'false'], { cwd: dir, encoding: 'utf8' });
  const clean = compile();
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);

  for (const file of ['app.js', 'reports.js', 'report-helpers.js']) {
    const path = join(dir, 'frontend', file);
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original + '\nnew Date().typecheckCoverageMissingProperty;\n');
    const broken = compile();
    assert.notEqual(broken.status, 0, `${file} was not checked`);
    assert.ok(broken.stdout.includes(`frontend/${file}(`), broken.stdout + broken.stderr);
    assert.match(broken.stdout, /TS2339: Property 'typecheckCoverageMissingProperty' does not exist on type 'Date'/);
    writeFileSync(path, original);
  }
});
