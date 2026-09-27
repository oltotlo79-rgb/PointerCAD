/** Inspect declared production dependencies without executing any package code. */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { env } from 'node:process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { runtimeDependencySelection } from './runtimeDependencySelection.mjs';

const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u;
function within(root, folder) {
  const actual = realpathSync(folder), path = relative(root, actual);
  if (isAbsolute(path) || path === '..' || path.startsWith('..' + sep)) throw new Error('Runtime dependency escaped the project');
  return actual;
}
function dependencyFolder(root, owner, name) {
  if (!packageName.test(name)) throw new Error('Invalid runtime dependency name');
  const require = createRequire(join(owner, 'package.json'));
  let folder;
  try { folder = dirname(require.resolve(name + '/package.json')); }
  catch { folder = dirname(require.resolve(name)); }
  folder = within(root, folder);
  for (;;) {
    const file = join(folder, 'package.json');
    if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name === name) return folder;
    const parent = dirname(folder);
    if (parent === folder || folder === root) throw new Error('Runtime package metadata is missing: ' + name);
    folder = within(root, parent);
  }
}

export function installedRuntimeDependencies(repository) {
  const sourceRoot = realpathSync(repository);
  let safeRoot = sourceRoot;
  while (!existsSync(join(safeRoot, '.git'))) {
    const parent = dirname(safeRoot);
    if (parent === safeRoot) throw new Error('Runtime dependency repository is missing');
    safeRoot = parent;
  }
  // Commit checks use a project-local worktree and share the main project's
  // installed packages. Resolve that same boundary without inheriting Git's
  // index/worktree variables from the hook.
  const gitEnvironment = Object.fromEntries(Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
  const gitDirectory = realpathSync(execFileSync('git', ['--no-optional-locks', '-C', sourceRoot,
    '-c', 'safe.directory=' + safeRoot.replaceAll('\\', '/'), 'rev-parse',
    '--path-format=absolute', '--git-common-dir'], { env: gitEnvironment, encoding: 'utf8', windowsHide: true }).trim());
  const root = dirname(gitDirectory), visited = new Set(), packages = new Map();
  const selectedDependencies = runtimeDependencySelection(sourceRoot);
  if (relative(root, gitDirectory) !== '.git') throw new Error('Unknown project metadata location');
  within(root, sourceRoot);
  const visit = (folder, parent, depth) => {
    folder = within(root, folder);
    if (depth > 64 || visited.size > 500) throw new Error('Excessive runtime dependency graph');
    const metadata = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
    if (!packageName.test(metadata.name) || typeof metadata.version !== 'string') throw new Error('Invalid runtime package identity');
    const key = metadata.name + '@' + metadata.version;
    const workspace = !relative(root, folder).split(sep).includes('node_modules');
    if (!workspace) {
      const existing = packages.get(key);
      if (existing && existing.license !== metadata.license) throw new Error('Conflicting runtime licenses: ' + key);
      const item = existing ?? { name: metadata.name, version: metadata.version, license: metadata.license,
        folders: new Set(), parents: new Set() };
      item.folders.add(folder); item.parents.add(parent); packages.set(key, item);
    }
    if (visited.has(folder)) return;
    visited.add(folder);
    for (const name of selectedDependencies(metadata).sort()) {
      let target;
      try { target = dependencyFolder(root, folder, name); }
      catch (error) {
        if (Object.hasOwn(metadata.optionalDependencies ?? {}, name) && error.code === 'MODULE_NOT_FOUND') continue;
        throw error;
      }
      visit(target, key, depth + 1);
    }
  };
  for (const owner of ['apps/web', 'apps/desktop']) visit(resolve(sourceRoot, owner), owner, 0);
  return [...packages.values()].map(item => ({ ...item, folders: [...item.folders].sort(), parents: [...item.parents].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export function verifyRuntimeDependencyInventory(actual, expected) {
  const key = item => item.name + '@' + item.version, records = new Map();
  for (const item of expected) {
    if (records.has(key(item))) throw new Error('Duplicate runtime dependency record');
    records.set(key(item), item.license);
  }
  if (actual.length !== records.size) throw new Error('Runtime dependency inventory changed');
  for (const item of actual) {
    if (!records.has(key(item)) || records.get(key(item)) !== item.license) throw new Error('Runtime dependency identity changed: ' + key(item));
    records.delete(key(item));
  }
  if (records.size !== 0) throw new Error('Runtime dependency is missing');
}
