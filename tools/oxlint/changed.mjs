import { execFileSync, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--base' || !args[1])) {
    throw new Error('Usage: npm run lint:slop:changed -- [--base REF]');
  }
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let base;
  try {
    const ref = args[1] ?? git('symbolic-ref', 'refs/remotes/origin/HEAD').trim();
    const commit = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
    base = git('merge-base', 'HEAD', commit).trim();
    if (!base) throw new Error('Empty merge base');
  } catch {
    throw new Error('Cannot resolve comparison base. Fetch origin history and set origin/HEAD, or pass --base REF with shared history.');
  }
  const paths = [
    ...git('diff', '--name-only', '--diff-filter=ACMR', '-z', base, '--').split('\0'),
    ...git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z', base, '--').split('\0'),
    ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0'),
  ];
  const files = [...new Set(paths)].filter(file => /\.[cm]?[jt]sx?$/.test(file) && !file.startsWith('tools/oxlint/anti-slop/') && statSync(resolve(root, file), { throwIfNoEntry: false })?.isFile());
  if (files.length === 0) {
    console.log('lint:slop:changed — no changed JS/TS files');
    return;
  }
  const result = spawnSync(resolve(root, 'node_modules/.bin/oxlint'), ['-c', '.oxlintrc.slop.json', '--max-warnings=0', '--', ...files], { cwd: root, stdio: 'inherit' });
  if (result.error) throw new Error('Cannot execute installed Oxlint. Run npm ci first.');
  process.exitCode = result.status ?? 1;
}

try {
  main();
} catch (error) {
  console.error(`lint:slop:changed: ${error.message}`);
  process.exitCode = 1;
}
