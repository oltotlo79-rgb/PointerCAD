import { readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { moduleSpecifiers, productFiles, unresolvedDynamicImports } from './packageImportBoundary.testSupport.js';
import { e2eImportBaseline } from './e2eImportBaseline.testSupport.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sourceFile = (path: string): boolean => /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(path);
interface Reference { consumer: string; specifier: string; target: string }

function references(consumer: string, source: string): Reference[] {
  if (!consumer.startsWith('e2e/')) return [];
  return moduleSpecifiers(consumer, source).flatMap(specifier => {
    const path = (specifier.split(/[?#]/u, 1)[0] ?? '').replaceAll('\\', '/');
    if (!path.startsWith('./') && !path.startsWith('../')) return [];
    const target = posix.normalize(posix.join(posix.dirname(consumer), path));
    return /^(?:packages|apps)(?:\/|$)/u.test(target) ? [{ consumer, specifier, target }] : [];
  });
}
function key(reference: Reference): string {
  return JSON.stringify([reference.consumer, reference.specifier, reference.target]);
}
function unapproved(found: readonly Reference[]): string[] {
  const counts = new Map<string, number>();
  const permitted = new Map(e2eImportBaseline.map(item => [key(item), item.count]));
  for (const reference of found) {
    const k = key(reference);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([k, count]) => count > (permitted.get(k) ?? 0)).map(([k]) => k).sort();
}
const forms = [
  (p: string) => `import value from '${p}';`,
  (p: string) => `import type { Value } from '${p}';`,
  (p: string) => `export { value } from '${p}';`,
  (p: string) => `export * from '${p}';`,
  (p: string) => `export type { Value } from '${p}';`,
  (p: string) => `const load = () => import('${p}');`,
  (p: string) => `const load = () => import(\`${p}\`);`,
  (p: string) => `type Value = typeof import('${p}').value;`,
];

describe('P10 e2e cross-layer relative imports', () => {
  it('does not add a product reference beyond the exact reasoned baseline', () => {
    const files = productFiles(root, 'e2e', sourceFile);
    expect(files.length).toBeGreaterThan(0);
    const sources = files.map(consumer => ({ consumer, text: readFileSync(resolve(root, consumer), 'utf8') }));
    const found = sources.flatMap(({ consumer, text }) => references(consumer, text));
    expect(sources.filter(({ consumer, text }) => unresolvedDynamicImports(consumer, text) > 0).map(({ consumer }) => consumer)).toEqual([]);
    expect(new Set(e2eImportBaseline.map(key)).size).toBe(e2eImportBaseline.length);
    expect(e2eImportBaseline.every(item => item.count > 0 && item.reason.trim().length > 0)).toBe(true);
    expect(unapproved(found)).toEqual([]);
  });

  it('rejects new consumers, query/fragment variants, folded paths and all module forms', () => {
    const item = e2eImportBaseline[0];
    const prefix = `${posix.dirname(item.consumer)}/future.ts`;
    for (const name of [item.specifier, `${item.specifier}?raw`, `${item.specifier}#fragment`,
      '../../packages/model/src/unused/../index.js']) {
      for (const form of forms) expect(unapproved(references(prefix, form(name))), form(name)).toHaveLength(1);
    }
    for (const suffix of ['?raw', '#fragment']) {
      for (const form of forms) expect(unapproved(references(item.consumer, form(item.specifier + suffix)))).toHaveLength(1);
    }
    const repeated = Array.from({ length: item.count + 1 }, () => references(item.consumer, forms[0](item.specifier))[0]);
    expect(unapproved(repeated)).toHaveLength(1);
  });

  it('ignores comments and ordinary strings and does not permit other consumer layers', () => {
    const text = "// import x from '../../packages/model/src/index.js';\n"
      + "const text = \"import('../../packages/model/src/index.js')\";";
    expect(references('e2e/tests/future.ts', text)).toEqual([]);
    expect(unresolvedDynamicImports('e2e/tests/future.ts', "const load = () => import('../../packages/' + name);")).toBe(1);
    expect(unresolvedDynamicImports('e2e/tests/future.ts', text)).toBe(0);
    expect(references('packages/ui/src/future.ts', forms[0]('../../model/src/index.js'))).toEqual([]);
    expect(references('e2e/tests/future.ts', forms[0]('./local.js'))).toEqual([]);
  });
});
