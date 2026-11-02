import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { moduleSpecifiers, productFiles, productTypeScript, testOnlyFile } from './packageImportBoundary.testSupport.js';

// E03 (R1): a file with a product name must not import vitest, must not call itself test-only, and must not import a
// *.test.* / *.testSupport.* module. Test code is named *.test.ts or *.testSupport.ts instead. Module specifiers come
// from the existing AST helper, so example imports inside comments never count.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const TEST_ONLY_NAME = /\btest[- ]only\b/iu;
type Rule = 'vitest' | 'test-only-name' | 'test-module-import';
/** Existing, reasoned exceptions only. Each row must still be needed (a stale row fails); no tree is skipped wholesale. */
const EXCEPTIONS: readonly { readonly path: string; readonly rule: Rule; readonly reason: string }[] = [
  { path: 'packages/test-utils/src/performanceSequencer.ts', rule: 'vitest',
    reason: 'Published only as @pointercad/test-utils/performance-sequencer for the vitest configs (package.json exports).' },
  { path: 'packages/expression/src/math/exactRuntimeTestSupport.ts', rule: 'vitest',
    reason: 'Existing exact-runtime test harness imported only by tests (named in eslint.config.js); renaming it is outside E03.' },
  { path: 'packages/model/src/testing/createNativeKernelBridge.node.ts', rule: 'test-module-import',
    reason: 'Node-test entry under testing/ (*ForNodeTests, imported only by kernel tests) that reuses the ex18 shape oracle.' },
  { path: 'packages/model/src/assembly/joints/mechanismCycleFixture.ts', rule: 'test-only-name',
    reason: 'Existing mechanism oracle fixture imported only by joint tests; renaming it is outside E03.' },
  { path: 'packages/model/src/assembly/standard/steelGolden.fixture.ts', rule: 'test-only-name',
    reason: 'Frozen golden fixture whose bytes are SHA-pinned by steelAngleChannelOracle.test.ts.' },
  { path: 'packages/model/src/assembly/standard/steelS45cOracle.fixture.ts', rule: 'test-only-name',
    reason: 'Independent transcription whose bytes are SHA-pinned by steelAngleChannelOracle.test.ts.' },
];

const productNamed = (path: string): boolean => productTypeScript(path) && !/\.d\.[cm]?ts$/u.test(path)
  && !/\.spec\.(?:[cm]?[jt]s|[jt]sx)$/u.test(path);
function sourceRoots(): string[] {
  return ['packages', 'apps'].flatMap(group => readdirSync(resolve(root, group), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(resolve(root, group, entry.name, 'src')))
    .map(entry => posix.join(group, entry.name, 'src')));
}
function ruleViolations(path: string, source: string): Rule[] {
  // Both import rules need one of these substrings, so other files skip the parse (keeps the full scan inside the limit).
  const specifiers = source.includes('vitest') || source.includes('.test') ? moduleSpecifiers(path, source) : [];
  const rules: Rule[] = [];
  if (specifiers.some(name => name === 'vitest' || name.startsWith('vitest/'))) rules.push('vitest');
  if (TEST_ONLY_NAME.test(source)) rules.push('test-only-name');
  if (specifiers.some(name => name.startsWith('.') && testOnlyFile.test(name.replace(/\?.*$/u, '')))) rules.push('test-module-import');
  return rules;
}

describe('検査専用の名前の方針（E03）', () => {
  it('製品名のファイルは vitest を import せず、test-only を名乗らず、検査用の module を import しない', () => {
    const found: string[] = [];
    for (const directory of sourceRoots()) for (const path of productFiles(root, directory, productNamed)) {
      for (const rule of ruleViolations(path, readFileSync(resolve(root, path), 'utf8'))) found.push(`${path} ${rule}`);
    }
    const allowed = EXCEPTIONS.map(row => `${row.path} ${row.rule}`);
    expect(found.filter(row => !allowed.includes(row))).toEqual([]);
    // A stale exception (file renamed, fixed or removed) must be deleted, not kept as a silent allowance.
    expect(allowed.filter(row => !found.includes(row))).toEqual([]);
    expect(EXCEPTIONS.every(row => row.reason.length > 0 && !testOnlyFile.test(row.path))).toBe(true);
  });

  it('コメント中の例は通し、製品の vitest・test-only・検査用 import は検出し、検査ファイルの検査用 import は通す', () => {
    const product = 'packages/model/src/part/example.ts';
    expect(ruleViolations(product, "// import { it } from 'vitest';\n/* from './a.testSupport.js' */\nexport const a = 1;\n")).toEqual([]);
    expect(ruleViolations(product, "import { it } from 'vitest';\nexport const a = it;\n")).toEqual(['vitest']);
    expect(ruleViolations(product, "import type { TestSpecification } from 'vitest/node';\nexport type A = TestSpecification;\n"))
      .toEqual(['vitest']);
    expect(ruleViolations(product, '/** Test-only builders. */\nexport const a = 1;\n')).toEqual(['test-only-name']);
    expect(ruleViolations(product, "export { a } from './a.testSupport.js';\n")).toEqual(['test-module-import']);
    expect(ruleViolations(product, "export const load = () => import('./b.test.js');\n")).toEqual(['test-module-import']);
    expect(ruleViolations(product, "import { a } from './latestOnly.js';\nexport const b = a;\n")).toEqual([]);
    for (const path of ['packages/model/src/part/example.test.ts', 'packages/model/src/part/example.testSupport.ts',
      'packages/model/src/part/example.d.ts', 'e2e/tests/example.spec.ts']) expect(productNamed(path), path).toBe(false);
    expect(productNamed(product)).toBe(true);
  });
});
