import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { offlineAssetUrl } from './offlineProtocol.mjs';
import { localGitEnvironment } from '../lib/gitEnvironment.mjs';

/** Capture the complete build source set, including additions and deletions before a commit. */
async function captureBuildSources(root, desktop) {
  const git = args => execFileSync('git', ['ls-files', '-z', ...args],
    { cwd: root, env: localGitEnvironment(), encoding: 'utf8', maxBuffer: 16_777_216,
      windowsHide: true }).split('\0').filter(Boolean);
  const deleted = new Set(git(['--deleted']));
  const names = [...new Set(git(['--cached', '--others', '--exclude-standard']))].filter(name => !deleted.has(name) && (
    (/^(?:packages\/|scripts\/(?:vite|release|lib)\/|vendor\/|docs\/standards\/licenses\/)/u.test(name)
      || (desktop ? name.startsWith('apps/desktop/') : name.startsWith('apps/web/')))
    || ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'LICENSE', 'NOTICE'].includes(name))).sort();
  const inputs = {};
  for (const name of names) {
    offlineAssetUrl(name);
    let path = root;
    for (const part of name.split('/')) {
      path = join(path, part); if ((await lstat(path)).isSymbolicLink()) throw new Error('Build source must not be a link');
    }
    if (!(await lstat(path)).isFile()) throw new Error('Build input is not a regular file');
    inputs[name] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  if (Object.keys(inputs).length === 0) throw new Error('Missing Web source inventory');
  return inputs;
}

export const captureWebBuildSources = root => captureBuildSources(root, false);
export const captureDesktopBuildSources = root => captureBuildSources(root, true);
