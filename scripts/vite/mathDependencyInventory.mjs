/** Inventory the installed dependencies without importing their runtime code. */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const OWNERS = new Map([
  ['packages/expression', '@cortex-js/compute-engine'],
  ['packages/ui', 'mathlive'],
]);

/** Resolve through the owning package, preserving different transitive versions. */
export function mathPackageFolder(root, chain) {
  if (!OWNERS.has(chain[0]) || chain[1] !== OWNERS.get(chain[0])) throw new Error('Unknown mathematics package owner');
  let folder = resolve(root, chain[0]);
  for (const name of chain.slice(1)) {
    if (!/^(@[a-z0-9-]+\/)?[a-z0-9.-]+$/.test(name)) throw new Error('Invalid package name');
    const require = createRequire(join(folder, 'package.json'));
    try { folder = dirname(require.resolve(`${name}/package.json`)); }
    catch { folder = dirname(require.resolve(name)); }
    while (!existsSync(join(folder, 'package.json')) || JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')).name !== name) {
      const parent = dirname(folder);
      if (parent === folder) throw new Error(`Package metadata missing: ${name}`);
      folder = parent;
    }
  }
  return folder;
}

export function installedMathDependencies(root) {
  const visited = new Map();
  const visit = (chain) => {
    if (chain.length > 64) throw new Error('Mathematics dependency nesting is too deep');
    const folder = mathPackageFolder(root, chain);
    const metadata = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
    const key = `${metadata.name}@${metadata.version}`;
    if (visited.has(key)) return;
    visited.set(key, { name: metadata.name, version: metadata.version, license: metadata.license });
    for (const dependency of Object.keys(metadata.dependencies ?? {})) visit([...chain, dependency]);
  };
  for (const [owner, name] of OWNERS) visit([owner, name]);
  return [...visited.values()];
}

/** A new transitive package must be reviewed even if every previous notice still matches. */
export function verifyMathDependencyInventory(actual, recorded) {
  const key = (entry) => `${entry.name}@${entry.version}`;
  const expected = new Map();
  for (const record of recorded) {
    const name = key(record);
    if (expected.has(name)) throw new Error(`Duplicate mathematics notice inventory: ${name}`);
    expected.set(name, record.license);
  }
  if (actual.length !== expected.size) throw new Error('Review the changed mathematics dependency inventory');
  for (const entry of actual) {
    const name = key(entry);
    if (!expected.has(name) || expected.get(name) !== entry.license) {
      throw new Error(`Review mathematics version and license: ${name}`);
    }
    expected.delete(name);
  }
  if (expected.size > 0) throw new Error('Mathematics dependency notices are missing');
}
