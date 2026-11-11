import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { offlineAssetUrl } from './offlineProtocol.mjs';
import { localGitEnvironment } from '../lib/gitEnvironment.mjs';
import { sourceFileHash } from '../release/desktopFileInventory.mjs';

/** The same path selection is used by capture and by callers checking its boundary. */
export function selectBuildSourceNames(names, deleted, desktop) {
  return [...new Set(names)].filter(name => !deleted.has(name) && (
    (/^(?:packages\/|scripts\/(?:vite|release|lib)\/|vendor\/|docs\/standards\/licenses\/)/u.test(name)
      || (desktop ? name.startsWith('apps/desktop/') : name.startsWith('apps/web/')))
    || ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'LICENSE', 'NOTICE'].includes(name))).sort();
}

/** List exactly the names that capture will hash, without reading their contents. */
function listBuildSourceNames(root, desktop) {
  const git = args => execFileSync('git', ['-c', 'safe.directory=' + realpathSync(root).replaceAll('\\', '/'),
    'ls-files', '-z', ...args],
    { cwd: root, env: localGitEnvironment(), encoding: 'utf8', maxBuffer: 16_777_216,
      windowsHide: true }).split('\0').filter(Boolean);
  const deleted = new Set(git(['--deleted']));
  return selectBuildSourceNames(git(['--cached', '--others', '--exclude-standard']), deleted, desktop);
}

export const listWebBuildSourceNames = root => listBuildSourceNames(root, false);

/** Capture the complete build source set, including additions and deletions before a commit. */
async function captureBuildSources(root, desktop) {
  const names = listBuildSourceNames(root, desktop);
  const inputs = {};
  for (const name of names) {
    offlineAssetUrl(name);
    let path = root;
    for (const part of name.split('/')) {
      path = join(path, part); if ((await lstat(path)).isSymbolicLink()) throw new Error('Build source must not be a link');
    }
    if (!(await lstat(path)).isFile()) throw new Error('Build input is not a regular file');
    // One value for the CRLF (Windows, core.autocrlf) and the LF (distribution CI) checkout of one commit.
    inputs[name] = sourceFileHash(await readFile(path));
  }
  if (Object.keys(inputs).length === 0) throw new Error('Missing Web source inventory');
  return inputs;
}

export const captureWebBuildSources = root => captureBuildSources(root, false);
export const captureDesktopBuildSources = root => captureBuildSources(root, true);
