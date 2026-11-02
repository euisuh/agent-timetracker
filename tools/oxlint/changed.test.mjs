import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runner = join(source, 'tools/oxlint/changed.mjs');
const invalid = "export const read = target => Reflect.get(target, 'id');\n";

function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), 'timetracker-lint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Gate test');
  git('config', 'user.email', 'gate-test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  cpSync(join(source, '.oxlintrc.json'), join(dir, '.oxlintrc.json'));
  cpSync(join(source, '.oxlintrc.slop.json'), join(dir, '.oxlintrc.slop.json'));
  cpSync(join(source, 'tools/oxlint/anti-slop'), join(dir, 'tools/oxlint/anti-slop'), { recursive: true });
  symlinkSync(join(source, 'node_modules'), join(dir, 'node_modules'), 'dir');
  writeFileSync(join(dir, 'existing.js'), 'export const count = 1;\n');
  git('add', '.');
  git('commit', '-m', 'fixture base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git('checkout', '-b', 'feature');
  const run = (...args) => spawnSync(process.execPath, [runner, ...args], { cwd: dir, encoding: 'utf8' });
  return { dir, git, run };
}

function rejects(result, pattern) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, pattern);
}

test('default branch merge base includes committed changes and invokes the real plugin', t => {
  const { dir, git, run } = repository(t);
  writeFileSync(join(dir, 'committed.js'), invalid);
  git('add', 'committed.js');
  git('commit', '-m', 'fixture violation');
  rejects(run(), /anti-slop\(no-reflect-get\)/);
});

test('explicit base works without origin/HEAD and supports invocation from a subdirectory', t => {
  const { dir, git } = repository(t);
  git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  mkdirSync(join(dir, 'nested'));
  writeFileSync(join(dir, 'valid.js'), 'export const answer = 42;\n');
  const result = spawnSync(process.execPath, [runner, '--base', 'main'], { cwd: join(dir, 'nested'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('missing default or explicit base fails even when no files changed', t => {
  const { git, run } = repository(t);
  git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  rejects(run(), /Cannot resolve comparison base/);
  rejects(run('--base', 'missing-branch'), /Cannot resolve comparison base/);
  rejects(run('--base', '--help'), /Cannot resolve comparison base/);
  rejects(run('--base'), /Usage:/);
});

test('unrelated explicit history fails instead of selecting HEAD', t => {
  const { git, run } = repository(t);
  git('checkout', '--orphan', 'unrelated');
  git('commit', '-m', 'unrelated root');
  git('checkout', 'feature');
  rejects(run('--base', 'unrelated'), /Cannot resolve comparison base/);
});

test('staged, unstaged and untracked paths are all checked without shell or newline splitting', t => {
  const { dir, git, run } = repository(t);
  writeFileSync(join(dir, 'existing.js'), invalid);
  writeFileSync(join(dir, 'staged.js'), invalid);
  git('add', 'staged.js');
  for (const name of ['untracked file.js', '--option.js', 'line\nbreak.js']) writeFileSync(join(dir, name), invalid);
  const result = run();
  rejects(result, /anti-slop\(no-reflect-get\)/);
  for (const fragment of ['existing.js', 'staged.js', 'untracked file.js', '--option.js', 'break.js']) {
    assert.ok((result.stdout + result.stderr).includes(fragment), `Missing diagnostic for ${fragment}`);
  }
});

test('staged paths remain selected when working-tree contents match the base', t => {
  const { dir, git, run } = repository(t);
  writeFileSync(join(dir, 'existing.js'), invalid);
  git('add', 'existing.js');
  writeFileSync(join(dir, 'existing.js'), 'export const count = 1;\n');
  rmSync(join(dir, 'node_modules'));
  rejects(run(), /Cannot execute installed Oxlint/);
});

test('staged additions deleted from the working tree are excluded', t => {
  const { dir, git, run } = repository(t);
  writeFileSync(join(dir, 'removed.js'), invalid);
  git('add', 'removed.js');
  rmSync(join(dir, 'removed.js'));
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /no changed JS\/TS files/);
});

test('renamed files are checked at their current path', t => {
  const { dir, git, run } = repository(t);
  writeFileSync(join(dir, 'existing.js'), invalid);
  git('add', 'existing.js');
  git('commit', '-m', 'fixture old violation');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('mv', 'existing.js', 'renamed.js');
  rejects(run(), /renamed.js/);
});

test('deleted, non-code and vendored files do not become lint targets', t => {
  const { dir, git, run } = repository(t);
  git('rm', 'existing.js');
  writeFileSync(join(dir, 'notes.md'), invalid);
  writeFileSync(join(dir, 'tools/oxlint/anti-slop/fixture.js'), invalid);
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /no changed JS\/TS files/);
});

test('missing local binary fails without downloading a replacement', t => {
  const { dir, run } = repository(t);
  rmSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'valid.js'), 'export const answer = 42;\n');
  rejects(run(), /Cannot execute installed Oxlint/);
});

test('root correctness lint and helper-only typecheck both reject real defects', t => {
  const { dir } = repository(t);
  mkdirSync(join(dir, 'frontend'));
  cpSync(join(source, 'tsconfig.helpers.json'), join(dir, 'tsconfig.helpers.json'));
  writeFileSync(join(dir, 'frontend/helpers.js'), 'export const elapsed = new Date() - new Date();\n');
  const check = spawnSync(join(source, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.helpers.json'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(check.status, 0);
  assert.match(check.stdout, /TS2362/);
  writeFileSync(join(dir, 'frontend/helpers.js'), 'export const check = value => { value === 1; };\n');
  const lint = spawnSync(join(source, 'node_modules/.bin/oxlint'), ['--max-warnings=0', 'frontend'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(lint.status, 0);
  assert.match(lint.stdout + lint.stderr, /no-unused-expressions/);
});

test('tool versions are exact and the helper typecheck scope is explicit', () => {
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  assert.equal(pkg.devDependencies.oxlint, '1.78.0');
  assert.equal(pkg.devDependencies['@oxlint/plugins'], '1.78.0');
  assert.equal(pkg.devDependencies.typescript, '6.0.3');
  const config = JSON.parse(readFileSync(join(source, 'tsconfig.helpers.json'), 'utf8'));
  assert.deepEqual(config.files, ['frontend/helpers.js']);
  assert.equal(config.compilerOptions.checkJs, true);
  assert.equal(config.compilerOptions.noEmit, true);
  assert.equal(config.compilerOptions.strict, false);
});
