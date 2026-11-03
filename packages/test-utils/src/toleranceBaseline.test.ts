import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { productFiles, productTypeScript } from './packageImportBoundary.testSupport.js';
import { checkedToleranceBaseline, handwrittenTolerance, originalToleranceExtra } from './toleranceBaseline.testSupport.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
function excess(current: readonly string[], allowed: Readonly<Record<string, number>>): string[] {
  const counts: Record<string, number> = {};
  for (const item of current) counts[item] = (counts[item] ?? 0) + 1;
  return Object.entries(counts).filter(([item, count]) => count > (allowed[item] ?? 0)).map(([item]) => item);
}
describe('new handwritten absolute-difference tolerances', () => {
  it('detects one new comparison while allowing an existing one', () => {
    const original = handwrittenTolerance('const a = Math.abs(x-y) <= t;');
    const allowed = Object.fromEntries(original.map(value => [value, 1]));
    expect(excess(original, allowed)).toEqual([]);
    expect(excess(handwrittenTolerance('const a = Math.abs(x-y) <= t; const b = Math.abs(u-v) <= t;'), allowed)).toHaveLength(1);
    expect(handwrittenTolerance('// Math.abs(x-y) <= t\nconst a = Math.abs(x) <= t;')).toEqual([]);
    expect(originalToleranceExtra('const x = Math.abs(a) <= tol;')).toHaveLength(1);
    expect(originalToleranceExtra('const x = Math.abs(a-b) <= tol;')).toEqual([]);
    expect(originalToleranceExtra('// Math.abs(a) <= tol')).toEqual([]);
    for (const bad of [-1, 1.5, NaN, '1']) {
      expect(() => checkedToleranceBaseline({ path: { expression: bad } })).toThrow('Invalid tolerance baseline count');
    }
  });
  it('does not add direct handwritten comparisons to product sources', () => {
    const baseline = checkedToleranceBaseline(JSON.parse(readFileSync(resolve(root, 'packages/test-utils/src/toleranceBaseline.json'), 'utf8')) as unknown);
    const extraBaseline = checkedToleranceBaseline(JSON.parse(readFileSync(resolve(root, 'packages/test-utils/src/toleranceOriginalExtraBaseline.json'), 'utf8')) as unknown);
    const roots = ['packages', 'apps'].flatMap(group => readdirSync(resolve(root, group), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(resolve(root, group, entry.name, 'src')))
      .map(entry => posix.join(group, entry.name, 'src')));
    const violations = roots.flatMap(dir => productFiles(root, dir, path => productTypeScript(path)
      && !/\.d\.[cm]?ts$/u.test(path) && !/\.spec\.(?:[cm]?[jt]s|[jt]sx)$/u.test(path)))
      .flatMap(path => {
        const source = readFileSync(resolve(root, path), 'utf8');
        return [...excess(handwrittenTolerance(source, path), baseline[path] ?? {}),
          ...excess(originalToleranceExtra(source, path), extraBaseline[path] ?? {})].map(item => path + ': ' + item);
      });
    expect(violations).toEqual([]);
  });
});
