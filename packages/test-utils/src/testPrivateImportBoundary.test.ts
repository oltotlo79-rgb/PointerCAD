import { readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { moduleSpecifiers, productFiles, testOnlyFile } from './packageImportBoundary.testSupport.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directions = {
  model: ['kernel', 'expression'],
  io: ['model', 'kernel'],
  fem: ['model', 'test-utils'],
} as const;
type Owner = keyof typeof directions;
function forbiddenTestImports(consumer: string, source: string): string[] {
  if (!testOnlyFile.test(consumer)) return [];
  const owner = (Object.keys(directions) as Owner[]).find(name => consumer.startsWith(`packages/${name}/src/`));
  if (owner === undefined) return [];
  const targets: readonly string[] = directions[owner];
  return moduleSpecifiers(consumer, source).filter(specifier => {
    const pathname = (specifier.split(/[?#]/u, 1)[0] ?? '').replaceAll('\\', '/');
    if (!pathname.startsWith('./') && !pathname.startsWith('../')) return false;
    const target = posix.normalize(posix.join(posix.dirname(consumer), pathname));
    return targets.some(name => target === `packages/${name}/src` || target.startsWith(`packages/${name}/src/`)
      || target === `packages/${name}/dist` || target.startsWith(`packages/${name}/dist/`));
  });
}
const forms = [
  (name: string) => `import value from '${name}';`,
  (name: string) => `import type { Value as Alias } from '${name}';`,
  (name: string) => `export { value } from '${name}';`,
  (name: string) => `export * from '${name}';`,
  (name: string) => `export type { Value } from '${name}';`,
  (name: string) => `const load = () => import('${name}');`,
  (name: string) => `const load = () => import(\`${name}\`);`,
  (name: string) => `type Value = typeof import('${name}').value;`,
];

describe('P09の6方向の検査越境は明示したpackage入口を使う', () => {
  it('model/io/FEMの全test/testSupportで別packageのsrc/distへの相対参照がない', () => {
    const failures: { path: string; specifier: string }[] = [];
    for (const owner of Object.keys(directions)) {
      const directory = `packages/${owner}/src`;
      const files = productFiles(root, directory, path => testOnlyFile.test(path));
      expect(files.length, directory).toBeGreaterThan(0);
      for (const path of files) {
        for (const specifier of forbiddenTestImports(path, readFileSync(resolve(root, path), 'utf8'))) {
          failures.push({ path, specifier });
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('6方向のstatic/type/export/dynamic/template参照をsrcとdistの両方で拒否する', () => {
    for (const owner of Object.keys(directions) as Owner[]) for (const target of directions[owner]) {
      const consumer = `packages/${owner}/src/future/nested.test.ts`;
      for (const tree of ['src', 'dist']) {
        const name = posix.relative(posix.dirname(consumer), `packages/${target}/${tree}/private.js`);
        for (const form of forms) expect(forbiddenTestImports(consumer, form(name)), `${owner} -> ${target}: ${form(name)}`)
          .toEqual([name]);
      }
    }
  });

  it('折返し・query・文字escapeを使っても同じprivate参照を拒否する', () => {
    const consumer = 'packages/model/src/nested/example.testSupport.ts';
    for (const name of ['../../../kernel/unused/../src/private.js', '../../../kernel/src/../dist/private.js?raw',
      '../../../kernel/src/private.js#fragment']) {
      for (const form of forms) expect(forbiddenTestImports(consumer, form(name))).toEqual([name]);
    }
    const escaped = "import value from '../../../\\u006bernel/src/private.js';";
    expect(forbiddenTestImports(consumer, escaped)).toEqual(['../../../kernel/src/private.js']);
  });

  it('コメント・普通文字列・同じpackage・公開入口は拒まない', () => {
    const consumer = 'packages/model/src/nested/example.test.ts';
    expect(forbiddenTestImports(consumer, "// import x from '../../../kernel/src/x.js';\n"
      + "/* export * from '../../../expression/dist/x.js'; */\n"
      + "const text = \"from '../../../kernel/src/x.js'\"; const kernel = 1;")).toEqual([]);
    for (const name of ['../sibling.js', '../../src/part/document.js', '@pointercad/kernel',
      '@pointercad/kernel/testing/occt-node', '@pointercad/expression/testing/geometry']) {
      for (const form of forms) expect(forbiddenTestImports(consumer, form(name))).toEqual([]);
    }
  });

  it('UIや製品runtimeやP09外の方向へ検査範囲を広げない', () => {
    for (const consumer of ['packages/ui/src/example.test.ts', 'packages/model/src/product.ts',
      'e2e/tests/example.spec.ts']) {
      expect(forbiddenTestImports(consumer, "import value from '../../kernel/src/private.js';")).toEqual([]);
    }
    expect(forbiddenTestImports('packages/model/src/nested/example.test.ts',
      "import value from '../../../drawing/src/private.js';")).toEqual([]);
  });
});
