import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

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

// P13: package-local helpers; offlineProtocol is a separate browser .mjs runtime.
const digestOwners = new Set([
  'packages/model/src/sha256.ts', 'packages/kernel/src/occt/sha256.ts',
  'packages/fem/src/sha256.ts', 'packages/ui/src/sha256.ts',
  'packages/ui/src/settings/offlineProtocol.mjs',
]);

function digestPolicyFiles(directory: string): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = posix.join(directory, entry.name);
    if (entry.isDirectory()) return excludedDirectories.has(entry.name.toLowerCase()) ? [] : digestPolicyFiles(path);
    return entry.isFile() && /\.(?:tsx?|mjs)$/u.test(path)
      && !/\.(?:d|test|testSupport|harness)\./u.test(path) ? [path] : [];
  });
}

function duplicateDigest(path: string, source: string): number {
  if (digestOwners.has(path)) return 0;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
    path.endsWith('.mjs') ? ts.ScriptKind.JS : path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let violations = 0;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'digest' && node.arguments[0] !== undefined
      && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === 'SHA-256') violations++;
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'sha256Hex') violations++;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'sha256Hex'
      && node.initializer !== undefined && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) violations++;
    ts.forEachChild(node, visit);
  }
  visit(file);
  return violations;
}

describe('P13 SHA-256 package-local implementation ownership', () => {
  it('keeps raw SHA-256 digest calls and sha256Hex implementations in their declared owners', () => {
    const files = sourceRoots().filter(path => path.startsWith('packages/')).flatMap(digestPolicyFiles);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter(path => duplicateDigest(path, readFileSync(resolve(root, path), 'utf8')) > 0)).toEqual([]);
  });
  it('rejects duplicate implementations, including a local subtle alias', () => {
    expect(duplicateDigest('packages/model/src/newDigest.ts', "subtle.digest('SHA-256', bytes);")).toBe(1);
    expect(duplicateDigest('packages/ui/src/newDigest.ts', 'function sha256Hex() { return value; }')).toBe(1);
    expect(duplicateDigest('packages/fem/src/newDigest.ts', 'const sha256Hex = () => value;')).toBe(1);
  });
  it('preserves declared runtime owners, comments, test exclusions and normal helper calls', () => {
    for (const path of digestOwners) expect(duplicateDigest(path, "crypto.subtle.digest('SHA-256', bytes);")).toBe(0);
    expect(duplicateDigest('packages/model/src/use.ts', "// crypto.subtle.digest('SHA-256', bytes)\nsha256Hex(bytes);")).toBe(0);
    expect(duplicateDigest('packages/model/src/use.ts', 'const note = "subtle.digest(\'SHA-256\', bytes)";')).toBe(0);
  });
});
