import { existsSync, readdirSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const excludedDirectories = new Set(['node_modules', 'dist', 'runtime-vendor']);

function implementationModule(path: string): boolean {
  return /\.tsx?$/iu.test(path) && !/\.d\.ts$/iu.test(path);
}

function sourceRoots(): string[] {
  return ['packages', 'apps'].flatMap(group => readdirSync(resolve(root, group), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(resolve(root, group, entry.name, 'src')))
    .map(entry => posix.join(group, entry.name, 'src'))).concat('e2e');
}

function implementationFiles(directory: string): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = posix.join(directory, entry.name);
    if (entry.isDirectory()) return excludedDirectories.has(entry.name.toLowerCase()) ? [] : implementationFiles(path);
    return entry.isFile() && implementationModule(path) ? [path] : [];
  }).sort();
}

function moduleCollisions(paths: readonly string[]): string[][] {
  const byStem = new Map<string, string[]>();
  for (const path of paths) {
    if (!implementationModule(path)) continue;
    const key = path.replace(/\\/gu, '/').replace(/\.tsx?$/iu, '').toLowerCase();
    const group = byStem.get(key);
    if (group === undefined) byStem.set(key, [path]);
    else group.push(path);
  }
  return [...byStem.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([, files]) => files.sort()).filter(files => files.length > 1);
}

// TypeScript 5.9.3 loadModuleFromFileNoImplicitExtensions/tryAddingExtensions strips .js and tries .ts before .tsx.
// Its Windows system host is case-insensitive. SolidResultExport.js can therefore resolve to solidResultExport.ts.
// Scan names only, including tests: no source parsing, compiler creation, vendor tree or scratchpad dependency.
describe('TypeScript implementation module names resolve unambiguously on Windows', () => {
  it('keeps case-insensitive module stems unique within each source directory', () => {
    const files = sourceRoots().flatMap(implementationFiles);
    expect(files.length).toBeGreaterThan(0);
    expect(moduleCollisions(files)).toEqual([]);
  });

  it.each([
    ['packages/ui/src/solidAnalysis/SolidResultExport.tsx', 'packages/ui/src/solidAnalysis/solidResultExport.ts'],
    ['packages/ui/src/Panel.ts', 'packages/ui/src/Panel.tsx'],
    ['packages/ui/src/Panel.ts', 'packages/ui/src/panel.ts'],
  ])('rejects %s colliding with %s', (first, second) => {
    expect(moduleCollisions([first, second])).toEqual([[first, second].sort()]);
  });

  it('allows declarations alongside their implementation', () => {
    expect(moduleCollisions(['packages/ui/src/Panel.ts', 'packages/ui/src/Panel.d.ts'])).toEqual([]);
  });

  it('allows matching filenames in separate directories', () => {
    expect(moduleCollisions(['packages/ui/src/a/Panel.ts', 'packages/ui/src/b/Panel.tsx'])).toEqual([]);
  });

  it('allows test and support stems distinct from the component stem', () => {
    expect(moduleCollisions(['packages/ui/src/Panel.tsx', 'packages/ui/src/Panel.test.ts',
      'packages/ui/src/Panel.testSupport.ts'])).toEqual([]);
  });
});
