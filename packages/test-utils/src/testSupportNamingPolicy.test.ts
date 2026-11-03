import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { moduleSpecifiers, productFiles, productTypeScript, testOnlyFile } from './packageImportBoundary.testSupport.js';

// E03 (R1): a file with a product name must not import vitest, must not call itself test-only, and must not import a
// *.test.* / *.testSupport.* module. Test code is named *.test.ts or *.testSupport.ts instead. Module specifiers come
// from the existing AST helper, so example imports inside comments never count.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const TEST_ONLY_NAME = /\btest[- ]only\b/iu;
type Rule = 'vitest' | 'test-only-name' | 'test-module-import' | 'kernel-test-subpath' | 'model-test-subpath'
  | 'expression-test-subpath' | 'test-utils-test-subpath' | 'fem-test-subpath' | 'io-test-subpath' | 'test-asset-subpath';
const TESTING_SUBPATHS: readonly { readonly specifier: string; readonly rule: Rule }[] = [
  { specifier: '@pointercad/kernel/testing/occt-node', rule: 'kernel-test-subpath' },
  { specifier: '@pointercad/kernel/testing/recompute-solids', rule: 'kernel-test-subpath' },
  { specifier: '@pointercad/kernel/testing/native-shape-inspection', rule: 'kernel-test-subpath' },
  { specifier: '@pointercad/kernel/testing/shape-cache', rule: 'kernel-test-subpath' },
  { specifier: '@pointercad/kernel/testing/borrow-handle', rule: 'kernel-test-subpath' },
  { specifier: '@pointercad/kernel/testing/intersection-volume', rule: 'kernel-test-subpath' },
  { specifier: '@pointercad/kernel/testing/export-mesh', rule: 'kernel-test-subpath' },
  { specifier: '@pointercad/kernel/testing/edit-solid-face', rule: 'kernel-test-subpath' },
  { specifier: '@pointercad/kernel/testing/build-boolean-shape', rule: 'kernel-test-subpath' },
  { specifier: '@pointercad/kernel/testing/make-sheet-metal-bend', rule: 'kernel-test-subpath' },
  { specifier: '@pointercad/kernel/testing/make-sheet-metal-body', rule: 'kernel-test-subpath' },
  { specifier: '@pointercad/kernel/testing/make-sheet-metal-curved-panel', rule: 'kernel-test-subpath' },
  { specifier: '@pointercad/kernel/testing/sheet-metal-join', rule: 'kernel-test-subpath' },
  { specifier: '@pointercad/kernel/testing/make-sheet-metal-base', rule: 'kernel-test-subpath' },
  { specifier: '@pointercad/kernel/testing/hole-placement-oracle-fixture', rule: 'kernel-test-subpath' },
  { specifier: '@pointercad/fem/testing/ui-fixtures', rule: 'fem-test-subpath' },
  { specifier: '@pointercad/io/testing/ui-fixtures', rule: 'io-test-subpath' },
  { specifier: '@pointercad/io/testing/read-archive', rule: 'io-test-subpath' },
  { specifier: '@pointercad/model/testing/ui-fixtures', rule: 'model-test-subpath' },
  { specifier: '@pointercad/model/testing/native-kernel', rule: 'model-test-subpath' },
  { specifier: '@pointercad/model/testing/analysis-fixtures', rule: 'model-test-subpath' },
  { specifier: '@pointercad/model/testing/connected-fixtures', rule: 'model-test-subpath' },
  { specifier: '@pointercad/model/testing/ex18-fixtures', rule: 'model-test-subpath' },
  { specifier: '@pointercad/model/testing/weld-fixtures', rule: 'model-test-subpath' },
  { specifier: '@pointercad/model/testing/io-operations', rule: 'model-test-subpath' },
  { specifier: '@pointercad/expression/testing/geometry', rule: 'expression-test-subpath' },
  { specifier: '@pointercad/expression/testing/exact-runtime', rule: 'expression-test-subpath' },
  { specifier: '@pointercad/test-utils/testing/release-performance', rule: 'test-utils-test-subpath' },
];
/** Existing, reasoned exceptions only. Each row must still be needed (a stale row fails); no tree is skipped wholesale. */
const EXCEPTIONS: readonly { readonly path: string; readonly rule: Rule; readonly reason: string }[] = [
  { path: 'packages/model/src/testing/createNativeKernelBridge.node.ts', rule: 'kernel-test-subpath',
    reason: 'Node test helper used by tests and E2E; its legacy name is retained.' },
  { path: 'packages/model/src/testing/inspectNativeCutShape.node.ts', rule: 'kernel-test-subpath',
    reason: 'Node test helper used by UI test; its legacy name is retained.' },
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
  const specifiers = source.includes('vitest') || source.includes('.test') || source.includes('@pointercad/fem/testing-assets/') || TESTING_SUBPATHS.some(row => source.includes(row.specifier))
    ? moduleSpecifiers(path, source) : [];
  const rules: Rule[] = [];
  if (specifiers.some(name => name.startsWith('@pointercad/fem/testing-assets/'))) rules.push('test-asset-subpath');
  if (specifiers.some(name => name === 'vitest' || name.startsWith('vitest/'))) rules.push('vitest');
  if (TEST_ONLY_NAME.test(source)) rules.push('test-only-name');
  for (const entry of TESTING_SUBPATHS) {
    if (!rules.includes(entry.rule) && specifiers.some(name => name.split(/[?#]/u, 1)[0] === entry.specifier)) rules.push(entry.rule);
  }
  if (specifiers.some(name => name.startsWith('.') && testOnlyFile.test(name.replace(/\?.*$/u, '')))) rules.push('test-module-import');
  return rules;
}

describe('検査専用の名前の方針（E03）', () => {
  it('明示した検査入口が実際のexportsと一致し、未検査の入口やwildcardで迂回しない', () => {
    const record = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value);
    for (const packageName of ['kernel', 'model', 'expression', 'test-utils', 'fem', 'io']) {
      const manifest: unknown = JSON.parse(readFileSync(resolve(root, 'packages', packageName, 'package.json'), 'utf8'));
      if (!record(manifest) || !record(manifest.exports)) throw new Error(`Missing package exports: ${packageName}`);
      expect(Object.keys(manifest.exports).filter(key => key.includes('*')), packageName).toEqual([]);
      const actual = Object.keys(manifest.exports).filter(key => key.startsWith('./testing/'))
        .map(key => `@pointercad/${packageName}/${key.slice(2)}`).sort();
      const expected = TESTING_SUBPATHS.filter(row => row.specifier.startsWith(`@pointercad/${packageName}/`))
        .map(row => row.specifier).sort();
      expect(actual, packageName).toEqual(expected);
      for (const key of Object.keys(manifest.exports).filter(name => name.startsWith('./testing/'))) {
        const entry = manifest.exports[key];
        if (!record(entry) || typeof entry.default !== 'string' || typeof entry.types !== 'string') {
          throw new Error(`Missing explicit source/types export: ${packageName} ${key}`);
        }
        expect(existsSync(resolve(root, 'packages', packageName, entry.default)), key).toBe(true);
        expect(entry.types.endsWith('.d.ts'), key).toBe(true);
      }
    }
  });

  it('全ての検査入口の値・型・再export・動的importを製品から拒否する', () => {
    const product = 'packages/fem/src/client.ts';
    for (const { specifier, rule } of TESTING_SUBPATHS) {
      for (const code of [
        `import { helper } from '${specifier}';`,
        `import type { Helper } from '${specifier}';`,
        `export { helper } from '${specifier}';`,
        `export type { Helper } from '${specifier}';`,
        `export * from '${specifier}';`,
        `const load = () => import('${specifier}');`,
        `const load = () => import('${specifier}?raw');`,
        `const load = () => import('${specifier}#test');`,
        `type Helper = typeof import('${specifier}').helper;`,
      ]) expect(ruleViolations(product, code), code).toEqual([rule]);
      expect(ruleViolations(product, `// import '${specifier}';`)).toEqual([]);
    }
  });

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
    const subpath = '@pointercad/kernel/testing/occt-node';
    for (const code of [
      `import { loadOcctForNode } from '${subpath}';`,
      `import type { loadOcctForNode } from '${subpath}';`,
      `export { loadOcctForNode } from '${subpath}';`,
      `export * from '${subpath}';`,
      `const run = () => import('${subpath}');`,
      `const run = () => import('${subpath}?raw');`,
      `type Loader = typeof import('${subpath}').loadOcctForNode;`,
    ]) expect(ruleViolations(product, code)).toEqual(['kernel-test-subpath']);
    expect(ruleViolations(product, `// import '${subpath}';`)).toEqual([]);
    const modelSubpath = '@pointercad/model/testing/analysis-fixtures';
    for (const path of ['packages/model/src/part/example.ts', 'packages/fem/src/client.ts', 'packages/ui/src/store/example.ts']) {
      for (const code of [
        `import { beamCadFixture } from '${modelSubpath}';`,
        `import type { beamCadFixture } from '${modelSubpath}';`,
        `export { beamCadFixture } from '${modelSubpath}';`,
        `export * from '${modelSubpath}';`,
        `const run = () => import('${modelSubpath}');`,
        `const run = () => import('${modelSubpath}?raw');`,
        `type Fixture = typeof import('${modelSubpath}').beamCadFixture;`,
      ]) expect(ruleViolations(path, code)).toEqual(['model-test-subpath']);
    }
    expect(ruleViolations(product, `// import '${modelSubpath}';`)).toEqual([]);
    expect(productNamed('packages/model/src/part/example.test.ts')).toBe(false);
    expect(productNamed('packages/io/src/pcad/example.testSupport.ts')).toBe(false);
    expect(productNamed(product)).toBe(true);
  });
});

const FEM_TEST_ASSET_PREFIX = '@pointercad/fem/testing-assets/';
const FEM_TEST_ASSET_OWNER = 'packages/ui/src/beam/boltPreloadDraft.test.ts';
const FEM_TEST_ASSETS = [
  { name: 'nativeBoltPreload.input.fixture.json', query: '?raw' },
  { name: 'nativeBoltPreload.result.fixture.json', query: '' },
] as const;
function allowedFemTestAsset(owner: string, specifier: string): boolean {
  return owner === FEM_TEST_ASSET_OWNER && FEM_TEST_ASSETS.some(row =>
    specifier === FEM_TEST_ASSET_PREFIX + row.name + row.query);
}

it('FEM生JSON検査資産は実在する2ファイルと既存の単一consumer/queryだけを許す', () => {
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const manifest: unknown = JSON.parse(readFileSync(resolve(root, 'packages/fem/package.json'), 'utf8'));
  if (!record(manifest) || !record(manifest.exports)) throw new Error('Missing FEM exports');
  expect(Object.keys(manifest.exports).filter(key => key.startsWith('./testing-assets/')).sort())
    .toEqual(FEM_TEST_ASSETS.map(row => './testing-assets/' + row.name).sort());
  for (const row of FEM_TEST_ASSETS) {
    const base = FEM_TEST_ASSET_PREFIX + row.name, specifier = base + row.query;
    expect(manifest.exports['./testing-assets/' + row.name]).toBe('./src/' + row.name);
    expect(existsSync(resolve(root, 'packages/fem/src', row.name))).toBe(true);
    expect(allowedFemTestAsset(FEM_TEST_ASSET_OWNER, specifier)).toBe(true);
    for (const invalid of [base + '?url', base + '?raw&other=1', base + '#raw', base + (row.query ? '' : '?raw'),
      FEM_TEST_ASSET_PREFIX + 'other.json', FEM_TEST_ASSET_PREFIX + 'nativeBoltPreload.ts']) {
      expect(allowedFemTestAsset(FEM_TEST_ASSET_OWNER, invalid), invalid).toBe(false);
    }
    for (const owner of ['packages/ui/src/beam/boltPreloadDraft.ts', 'packages/ui/src/beam/other.test.ts',
      'packages/fem/src/runtime.ts']) expect(allowedFemTestAsset(owner, specifier)).toBe(false);
    for (const code of [`import value from '${specifier}';`, `import type { Value } from '${specifier}';`,
      `export * from '${specifier}';`, `const load = () => import('${specifier}');`,
      `type Value = typeof import('${specifier}');`]) {
      expect(ruleViolations('packages/ui/src/runtime.ts', code)).toContain('test-asset-subpath');
    }
  }
  const found: string[] = [];
  for (const directory of sourceRoots()) for (const path of productFiles(root, directory, name => /\.[cm]?tsx?$/u.test(name))) {
    const source = readFileSync(resolve(root, path), 'utf8');
    if (!source.includes(FEM_TEST_ASSET_PREFIX)) continue;
    for (const specifier of moduleSpecifiers(path, source)) if (specifier.startsWith(FEM_TEST_ASSET_PREFIX)) {
      expect(allowedFemTestAsset(path, specifier), path + ': ' + specifier).toBe(true);
      found.push(path + ': ' + specifier);
    }
  }
  expect(found.sort()).toEqual(FEM_TEST_ASSETS.map(row =>
    FEM_TEST_ASSET_OWNER + ': ' + FEM_TEST_ASSET_PREFIX + row.name + row.query).sort());
});

// P16 group 2: the unguarded three-component hypot/divide helper, not all functions named unit.
function copiedNormalizeBodies(path: string, source: string): number {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  let count = 0;
  function visit(node: ts.Node): void {
    if ((ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))
      && node.body && ts.isBlock(node.body) && node.parameters.length === 1) {
      const nameNode = ts.isFunctionDeclaration(node) ? node.name
        : ts.isVariableDeclaration(node.parent) ? node.parent.name : undefined;
      if (!nameNode || !ts.isIdentifier(nameNode) || !['normalizePoint', 'unit'].includes(nameNode.text)) {
        ts.forEachChild(node, visit);
        return;
      }
      const parameter = node.parameters[0]?.name;
      const [first, second] = node.body.statements;
      if (parameter && ts.isIdentifier(parameter) && node.body.statements.length === 2
        && first && ts.isVariableStatement(first) && first.declarationList.declarations.length === 1
        && second && ts.isReturnStatement(second) && second.expression && ts.isArrayLiteralExpression(second.expression)) {
        const declaration = first.declarationList.declarations[0];
        if (declaration && ts.isIdentifier(declaration.name) && declaration.initializer
          && ts.isCallExpression(declaration.initializer) && declaration.initializer.expression.getText(ast) === 'Math.hypot') {
          const name = parameter.text, length = declaration.name.text;
          const compact = (part: ts.Node): string => part.getText(ast).replace(/\s/gu, '');
          const args = declaration.initializer.arguments.map(compact);
          const result = second.expression.elements.map(compact);
          if (args.join('|') === [0, 1, 2].map(index => `${name}[${index}]`).join('|')
            && result.join('|') === [0, 1, 2].map(index => `${name}[${index}]/${length}`).join('|')) count++;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return count;
}

it('P16の3成分正規化は正規testSupport以外へ再定義しない', () => {
  const allowed = new Set(['e2e/tests/normalizePoint.testSupport.ts', 'packages/kernel/src/occt/pointAssertions.testSupport.ts']);
  const paths = [
    ...productFiles(root, 'e2e/tests', path => /\.ts$/u.test(path)),
    ...productFiles(root, 'packages/kernel/src/occt', path => /\.(?:test|testSupport)\.ts$/u.test(path)),
  ];
  const found = paths.flatMap(path => copiedNormalizeBodies(path, readFileSync(resolve(root, path), 'utf8')) > 0 ? [path] : []);
  expect(found.filter(path => !allowed.has(path))).toEqual([]);
  expect([...allowed].filter(path => !found.includes(path))).toEqual([]);
});

it('P16再コピーの実体だけを検出し、文字列・型・別契約を通す', () => {
  const path = 'e2e/tests/example.spec.ts';
  const body = 'const length = Math.hypot(a[0], a[1], a[2]); return [a[0] / length, a[1] / length, a[2] / length];';
  expect(copiedNormalizeBodies(path, `function normalizePoint(a: number[]) { ${body} }`)).toBe(1);
  expect(copiedNormalizeBodies(path, `const unit = (a: number[]) => { ${body} };`)).toBe(1);
  expect(copiedNormalizeBodies(path, 'function unit(v: number[]) { const n = Math.hypot(v[0],v[1],v[2]); return [v[0]/n,v[1]/n,v[2]/n]; }')).toBe(1);
  expect(copiedNormalizeBodies(path, `// function fake(a) { ${body} }\nconst text = ${JSON.stringify(body)};`)).toBe(0);
  expect(copiedNormalizeBodies(path, 'type Unit = (a: number[]) => number[];')).toBe(0);
  expect(copiedNormalizeBodies(path, 'function unit(a: number[]) { const n = Math.hypot(a[0],a[1],a[2]); return n === 0 ? a : [a[0]/n,a[1]/n,a[2]/n]; }')).toBe(0);
  expect(copiedNormalizeBodies(path, 'function oracle(a: number[]) { const n = Math.sqrt(a[0]**2+a[1]**2+a[2]**2); return [a[0]/n,a[1]/n,a[2]/n]; }')).toBe(0);
  expect(copiedNormalizeBodies(path, `function independentOracle(a: number[]) { ${body} }`)).toBe(0);
});

// P16 group 6: detect the original attachment-copy body, not same-named wrappers.
const OLD_ATTACHMENT_COPY = `function replaceAttachment(serialized: string, value: unknown): string {
  const envelope: unknown = JSON.parse(serialized);
  if (!isRecord(envelope) || !isRecord(envelope.document)) throw new Error('Expected a document envelope');
  return JSON.stringify({ ...envelope, document: { ...envelope.document, beamAnalysisInputs: value } });
}`;
function attachmentCopyCount(path: string, source: string): number {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  let count = 0;
  function fingerprint(node: ts.FunctionDeclaration): string | undefined {
    const params = node.parameters;
    const statement = node.body?.statements[0];
    if (!node.body || params.length !== 2 || !params[0] || !params[1]
      || !ts.isIdentifier(params[0].name) || !ts.isIdentifier(params[1].name)
      || !statement || !ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined;
    const declaration = statement.declarationList.declarations[0];
    if (!declaration || !ts.isIdentifier(declaration.name)) return undefined;
    const names = new Map([[params[0].name.text, '$arg0'], [params[1].name.text, '$arg1'], [declaration.name.text, '$local']]);
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, node.body.getText(ast));
    const tokens: string[] = [];
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      const text = scanner.getTokenText();
      tokens.push(token === ts.SyntaxKind.Identifier ? names.get(text) ?? text : text);
    }
    return JSON.stringify(tokens);
  }
  const original = ts.createSourceFile('original.ts', OLD_ATTACHMENT_COPY, ts.ScriptTarget.Latest, true).statements[0];
  if (!original || !ts.isFunctionDeclaration(original)) throw new Error('Missing P16 baseline');
  // Baseline nodes must be printed using their own source file.
  const baselineText = original.body?.getText();
  if (!baselineText) throw new Error('Missing P16 baseline body');
  const baselineScanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, baselineText);
  const baselineNames = new Map([['serialized', '$arg0'], ['value', '$arg1'], ['envelope', '$local']]);
  const baselineTokens: string[] = [];
  for (let token = baselineScanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = baselineScanner.scan()) {
    const text = baselineScanner.getTokenText();
    baselineTokens.push(token === ts.SyntaxKind.Identifier ? baselineNames.get(text) ?? text : text);
  }
  const baseline = JSON.stringify(baselineTokens);
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name && ['replaceAttachment', 'withAttachment'].includes(node.name.text)
      && fingerprint(node) === baseline) count++;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return count;
}

it('P16の保存入力コピーを検査consumerへ再定義しない', () => {
  const paths = productFiles(root, 'packages/io/src/pcad', path => /\.test\.ts$/u.test(path));
  const duplicates = paths.filter(path => attachmentCopyCount(path, readFileSync(resolve(root, path), 'utf8')) > 0);
  expect(duplicates).toEqual([]);
});

it('保存入力の旧コピーは検出し、別契約とコメントを許す', () => {
  const path = 'packages/io/src/pcad/example.test.ts';
  expect(attachmentCopyCount(path, OLD_ATTACHMENT_COPY)).toBe(1);
  expect(attachmentCopyCount(path, OLD_ATTACHMENT_COPY.replace('replaceAttachment', 'withAttachment'))).toBe(1);
  expect(attachmentCopyCount(path, `// ${OLD_ATTACHMENT_COPY.split('\n').join('\n// ')}`)).toBe(0);
  expect(attachmentCopyCount(path, `const text = ${JSON.stringify(OLD_ATTACHMENT_COPY)};`)).toBe(0);
  expect(attachmentCopyCount(path, "function replaceAttachment(text: string, value: unknown) { return replaceAttachmentWithMessage(text, value, 'Expected actual PCAD envelope'); }")).toBe(0);
  expect(attachmentCopyCount(path, OLD_ATTACHMENT_COPY.replace('beamAnalysisInputs', 'solidAnalysisInputs'))).toBe(0);
});

// P16 group 10: only the original face fingerprint projection, not same-named wrappers.
function copiedFaceQueryCount(path: string, source: string, reference: string): number {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  function fingerprints(file: ts.SourceFile, names: readonly string[]): string[] {
    const found: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)
        && node.body && node.parameters.length === 1 && node.parameters[0] && ts.isIdentifier(node.parameters[0].name)) {
        const parameter = node.parameters[0].name.text;
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, node.body.getText(file));
        const tokens: string[] = [];
        for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
          const text = scanner.getTokenText();
          tokens.push(token === ts.SyntaxKind.Identifier && text === parameter ? '$face' : text);
        }
        found.push(JSON.stringify(tokens));
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    return found;
  }
  const referenceFile = ts.createSourceFile('reference.ts', reference, ts.ScriptTarget.Latest, true);
  const baseline = fingerprints(referenceFile, ['solidFaceQuery']);
  if (baseline.length !== 1) throw new Error('Expected one canonical solidFaceQuery');
  return fingerprints(ast, ['faceQuery', 'solidFaceQuery']).filter(value => value === baseline[0]).length;
}

it('P16の面指紋変換を検査consumerへ再コピーしない', () => {
  const reference = readFileSync(resolve(root, 'packages/kernel/src/occt/solidFaceQuery.testSupport.ts'), 'utf8');
  const files = productFiles(root, 'packages/kernel/src', path => /\.test\.ts$/u.test(path));
  expect(files.filter(path => copiedFaceQueryCount(path, readFileSync(resolve(root, path), 'utf8'), reference) > 0)).toEqual([]);
});

it('面指紋のコピーは検出し、委譲と別契約を許す', () => {
  const reference = readFileSync(resolve(root, 'packages/kernel/src/occt/solidFaceQuery.testSupport.ts'), 'utf8');
  const copy = reference.replace('solidFaceQuery', 'faceQuery');
  expect(copiedFaceQueryCount('example.test.ts', copy, reference)).toBe(1);
  expect(copiedFaceQueryCount('example.test.ts', '// ' + copy.split('\n').join('\n// '), reference)).toBe(0);
  expect(copiedFaceQueryCount('example.test.ts', 'function faceQuery(face: Face) { return solidFaceQuery(face); }', reference)).toBe(0);
  expect(copiedFaceQueryCount('example.test.ts', copy.replace('axis: face.axis', 'axis: null'), reference)).toBe(0);
});

// P16 group 14: the old special-function request body, retaining each document ID.
const OLD_SPECIAL_REQUEST = `function request(source: string, angleUnit: 'degree' | 'radian' = 'radian') {
  return {source,angleUnit,notation:'text' as const,coefficients:[],
    identity:{documentId:'airy-functions',documentVersion:1,editorId:'coordinate',inputRevision:1}};
}`;
function copiedSpecialRequestCount(path: string, source: string): number {
  function fingerprints(file: ts.SourceFile): string[] {
    const result: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'request' && node.body && node.parameters.length === 2) {
        const body = node.body.getText(file).replace(/(documentId\s*:\s*)['"][^'"]+['"]/gu, '$1"$document"');
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, body);
        const tokens: string[] = [];
        for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) tokens.push(scanner.getTokenText());
        result.push(JSON.stringify(tokens));
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    return result;
  }
  const baseline = fingerprints(ts.createSourceFile('baseline.ts', OLD_SPECIAL_REQUEST, ts.ScriptTarget.Latest, true));
  if (baseline.length !== 1) throw new Error('Missing P16 special request baseline');
  return fingerprints(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)).filter(value => value === baseline[0]).length;
}

it('P16のspecial request本体を各検査へ再コピーしない', () => {
  const files = productFiles(root, 'packages/expression/src/math', path => /\.test\.ts$/u.test(path));
  expect(files.filter(path => copiedSpecialRequestCount(path, readFileSync(resolve(root, path), 'utf8')) > 0)).toEqual([]);
});

it('special requestの同一コピーを検出し、別identity契約と委譲を許す', () => {
  const path = 'packages/expression/src/math/example.test.ts';
  expect(copiedSpecialRequestCount(path, OLD_SPECIAL_REQUEST)).toBe(1);
  expect(copiedSpecialRequestCount(path, OLD_SPECIAL_REQUEST.replace('airy-functions', 'bessel-functions'))).toBe(1);
  expect(copiedSpecialRequestCount(path, OLD_SPECIAL_REQUEST.replace("editorId:'coordinate'", "editorId:'X'"))).toBe(0);
  expect(copiedSpecialRequestCount(path, 'function request(source: string, angleUnit: string) { return specialMathTestRequest(source, angleUnit, "id"); }')).toBe(0);
  expect(copiedSpecialRequestCount(path, '// ' + OLD_SPECIAL_REQUEST.split('\n').join('\n// '))).toBe(0);
});

// P16 group 9: same three comparisons with the same digits default, never a wrapper or another contract.
function copiedPointAssertionCount(path: string, source: string, reference: string, referenceName: string): number {
  function fingerprints(file: ts.SourceFile, names: readonly string[]): string[] {
    const rows: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text) && node.body && node.parameters.length === 3
        && node.parameters.every(parameter => ts.isIdentifier(parameter.name))) {
        const parameterNames = node.parameters.map(parameter => parameter.name.getText(file));
        const defaults = node.parameters.map(parameter => parameter.initializer?.getText(file) ?? '-');
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, node.body.getText(file));
        const tokens: string[] = [];
        for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
          const text = scanner.getTokenText(), index = token === ts.SyntaxKind.Identifier ? parameterNames.indexOf(text) : -1;
          tokens.push(index < 0 ? text : `$parameter${index}`);
        }
        rows.push(JSON.stringify({ defaults, tokens }));
      }
      ts.forEachChild(node, visit);
    }
    visit(file); return rows;
  }
  const baseline = fingerprints(ts.createSourceFile('reference.ts', reference, ts.ScriptTarget.Latest, true), [referenceName]);
  if (baseline.length !== 1) throw new Error('Expected one point assertion baseline');
  return fingerprints(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true),
    ['expectPointClose', 'expectTuple', 'expectCloseTo', 'expectVec3CloseTo']).filter(row => row === baseline[0]).length;
}

it('P16の同じ精度契約の点比較を検査consumerへ再コピーしない', () => {
  for (const [directory, referencePath, name] of [
    ['packages/kernel/src', 'packages/kernel/src/occt/pointAssertions.testSupport.ts', 'expectPointClose'],
    ['packages/model/src', 'packages/model/src/testing/vec3Assertions.testSupport.ts', 'expectVec3CloseTo'],
  ]) {
    const reference = readFileSync(resolve(root, referencePath), 'utf8');
    const files = productFiles(root, directory, path => /\.test\.ts$/u.test(path));
    expect(files.filter(path => copiedPointAssertionCount(path, readFileSync(resolve(root, path), 'utf8'), reference, name) > 0)).toEqual([]);
  }
});

it('点比較は同じ本体かつ同じ既定桁のみ拒み、別既定桁と委譲を許す', () => {
  const reference = readFileSync(resolve(root, 'packages/model/src/testing/vec3Assertions.testSupport.ts'), 'utf8');
  const copy = reference.replace('expectVec3CloseTo', 'expectCloseTo');
  expect(copiedPointAssertionCount('example.test.ts', copy, reference, 'expectVec3CloseTo')).toBe(1);
  expect(copiedPointAssertionCount('example.test.ts', copy.replace('digits = 9', 'digits = 12'), reference, 'expectVec3CloseTo')).toBe(0);
  expect(copiedPointAssertionCount('example.test.ts', 'function expectCloseTo(a,b,digits=12) { expectVec3CloseTo(a,b,digits); }', reference, 'expectVec3CloseTo')).toBe(0);
  expect(copiedPointAssertionCount('example.test.ts', '// ' + copy.split('\n').join('\n// '), reference, 'expectVec3CloseTo')).toBe(0);
});

// P16 group 1: the original console/pageerror collector, not a differently filtered collector.
function copiedRuntimeErrorsCount(path: string, source: string, reference: string): number {
  function fingerprints(file: ts.SourceFile): string[] {
    const rows: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'collectErrors' && node.body && node.parameters.length === 1
        && node.parameters[0] && ts.isIdentifier(node.parameters[0].name)) {
        const name = node.parameters[0].name.text;
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, node.body.getText(file));
        const tokens: string[] = [];
        for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
          const text = scanner.getTokenText(); tokens.push(token === ts.SyntaxKind.Identifier && text === name ? '$page' : text);
        }
        rows.push(JSON.stringify(tokens));
      }
      ts.forEachChild(node, visit);
    }
    visit(file); return rows;
  }
  const baseline = fingerprints(ts.createSourceFile('reference.ts', reference, ts.ScriptTarget.Latest, true));
  if (baseline.length !== 1) throw new Error('Expected one error collector');
  return fingerprints(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)).filter(row => row === baseline[0]).length;
}

it('P16の画面エラー収集をconsumerへ再コピーしない', () => {
  const reference = readFileSync(resolve(root, 'e2e/tests/runtimeErrors.ts'), 'utf8');
  const files = productFiles(root, 'e2e/tests', path => /\.ts$/u.test(path) && path !== 'e2e/tests/runtimeErrors.ts');
  expect(files.filter(path => copiedRuntimeErrorsCount(path, readFileSync(resolve(root, path), 'utf8'), reference) > 0)).toEqual([]);
});

it('同じエラー収集本体だけ検出し、異なるfilterとコメントを通す', () => {
  const reference = readFileSync(resolve(root, 'e2e/tests/runtimeErrors.ts'), 'utf8');
  expect(copiedRuntimeErrorsCount('example.spec.ts', reference, reference)).toBe(1);
  expect(copiedRuntimeErrorsCount('example.spec.ts', reference.replace("=== 'error'", "=== 'warning'"), reference)).toBe(0);
  expect(copiedRuntimeErrorsCount('example.spec.ts', '// ' + reference.split('\n').join('\n// '), reference)).toBe(0);
});

// P16 group 15: same picker-disabling body; ignore optional trailing commas only.
function copiedFilePickerCount(path: string, source: string, reference: string): number {
  function fingerprints(file: ts.SourceFile): string[] {
    const rows: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'disableFilePickers' && node.body) {
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, node.body.getText(file));
        const items: { kind: ts.SyntaxKind; text: string }[] = [];
        for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) items.push({ kind, text: scanner.getTokenText() });
        rows.push(JSON.stringify(items.filter((item, index) => item.kind !== ts.SyntaxKind.CommaToken
          || ![ts.SyntaxKind.CloseBraceToken, ts.SyntaxKind.CloseBracketToken, ts.SyntaxKind.CloseParenToken].includes(items[index + 1]?.kind ?? ts.SyntaxKind.Unknown))
          .map(item => item.text)));
      }
      ts.forEachChild(node, visit);
    }
    visit(file); return rows;
  }
  const baseline = fingerprints(ts.createSourceFile('reference.ts', reference, ts.ScriptTarget.Latest, true));
  if (baseline.length !== 1) throw new Error('Expected one picker baseline');
  return fingerprints(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)).filter(value => value === baseline[0]).length;
}

it('P16のfile picker無効化をconsumerへ再コピーしない', () => {
  const reference = readFileSync(resolve(root, 'e2e/tests/filePickers.ts'), 'utf8');
  const files = productFiles(root, 'e2e/tests', path => /\.ts$/u.test(path) && path !== 'e2e/tests/filePickers.ts');
  expect(files.filter(path => copiedFilePickerCount(path, readFileSync(resolve(root, path), 'utf8'), reference) > 0)).toEqual([]);
});

it('同じpicker設定だけ拒み、異なる設定やコメントを許す', () => {
  const reference = readFileSync(resolve(root, 'e2e/tests/filePickers.ts'), 'utf8');
  expect(copiedFilePickerCount('example.spec.ts', reference, reference)).toBe(1);
  expect(copiedFilePickerCount('example.spec.ts', reference.replace('writable: true', 'writable: false'), reference)).toBe(0);
  expect(copiedFilePickerCount('example.spec.ts', '// ' + reference.split('\n').join('\n// '), reference)).toBe(0);
});

// P16 group 7: original menu opening, preserving alternatives with different selectors or waits.
function copiedToolMenuCount(path: string, source: string, reference: string): number {
  function fingerprints(file: ts.SourceFile): string[] {
    const rows: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'openToolMenu' && node.body) {
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, node.body.getText(file));
        const tokens: string[] = [];
        for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) tokens.push(scanner.getTokenText());
        rows.push(JSON.stringify(tokens));
      }
      ts.forEachChild(node, visit);
    }
    visit(file); return rows;
  }
  const baseline = fingerprints(ts.createSourceFile('reference.ts', reference, ts.ScriptTarget.Latest, true));
  if (baseline.length !== 1) throw new Error('Expected one menu helper');
  return fingerprints(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)).filter(value => value === baseline[0]).length;
}

it('P16のtool menu共通本体をconsumerへ再コピーしない', () => {
  const reference = readFileSync(resolve(root, 'e2e/tests/toolMenus.ts'), 'utf8');
  const files = productFiles(root, 'e2e/tests', path => /\.ts$/u.test(path) && path !== 'e2e/tests/toolMenus.ts');
  expect(files.filter(path => copiedToolMenuCount(path, readFileSync(resolve(root, path), 'utf8'), reference) > 0)).toEqual([]);
});

it('tool menuの同一本体を検出し、別の待機とコメントを許す', () => {
  const reference = readFileSync(resolve(root, 'e2e/tests/toolMenus.ts'), 'utf8');
  expect(copiedToolMenuCount('example.spec.ts', reference, reference)).toBe(1);
  expect(copiedToolMenuCount('example.spec.ts', reference.replace('toBeVisible()', 'toBeHidden()'), reference)).toBe(0);
  expect(copiedToolMenuCount('example.spec.ts', '// ' + reference.split('\n').join('\n// '), reference)).toBe(0);
});

// P16 group 5: only the null-skipping popoverFields body; other contracts remain independent.
function copiedPopoverFieldsCount(path: string, source: string, reference: string): number {
  function fingerprints(file: ts.SourceFile): string[] {
    const rows: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'fillFields' && node.body) {
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, node.body.getText(file));
        const tokens: string[] = [];
        for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) tokens.push(scanner.getTokenText());
        rows.push(JSON.stringify(tokens));
      }
      ts.forEachChild(node, visit);
    }
    visit(file); return rows;
  }
  const baseline = fingerprints(ts.createSourceFile('reference.ts', reference, ts.ScriptTarget.Latest, true));
  if (baseline.length !== 1) throw new Error('Expected one fillFields helper');
  return fingerprints(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)).filter(value => value === baseline[0]).length;
}

it('P16のnullを飛ばす欄入力をconsumerへ再コピーしない', () => {
  const reference = readFileSync(resolve(root, 'e2e/tests/popoverFields.ts'), 'utf8');
  const files = productFiles(root, 'e2e/tests', path => /\.ts$/u.test(path) && path !== 'e2e/tests/popoverFields.ts');
  expect(files.filter(path => copiedPopoverFieldsCount(path, readFileSync(resolve(root, path), 'utf8'), reference) > 0)).toEqual([]);
});

it('欄入力の同一本体のみ検出し、異なるnull契約とコメントを許す', () => {
  const reference = readFileSync(resolve(root, 'e2e/tests/popoverFields.ts'), 'utf8');
  expect(copiedPopoverFieldsCount('example.spec.ts', reference, reference)).toBe(1);
  expect(copiedPopoverFieldsCount('example.spec.ts', reference.replace('source === null', 'source !== null'), reference)).toBe(0);
  expect(copiedPopoverFieldsCount('example.spec.ts', '// ' + reference.split('\n').join('\n// '), reference)).toBe(0);
});

// P16 group 3: the original degree/coordinate request shape, with the document ID left to each caller.
const OLD_DEGREE_INPUT = `function input(source: string) {
  return { source, angleUnit: 'degree', notation: 'text', coefficients: [],
    identity: { documentId: 'discrete-quantiles', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
}`;
function copiedDegreeInputCount(path: string, source: string): number {
  function fingerprints(file: ts.SourceFile): string[] {
    const rows: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isFunctionDeclaration(node) && node.name && ['input', 'request', 'latexRequest'].includes(node.name.text)
        && node.body && node.parameters.length === 1) {
        const body = node.body.getText(file).replace(/(documentId\s*:\s*)['"][^'"]+['"]/gu, '$1"$document"');
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, body);
        const tokens: string[] = [];
        for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) tokens.push(scanner.getTokenText());
        rows.push(JSON.stringify(tokens));
      }
      ts.forEachChild(node, visit);
    }
    visit(file); return rows;
  }
  const baseline = fingerprints(ts.createSourceFile('baseline.ts', OLD_DEGREE_INPUT, ts.ScriptTarget.Latest, true));
  if (baseline.length !== 1) throw new Error('Missing degree input baseline');
  return fingerprints(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)).filter(value => value === baseline[0]).length;
}

it('P16のdegree入力生成をconsumerへ再コピーしない', () => {
  const files = productFiles(root, 'packages/expression/src/math', path => /\.test\.ts$/u.test(path));
  expect(files.filter(path => copiedDegreeInputCount(path, readFileSync(resolve(root, path), 'utf8')) > 0)).toEqual([]);
});

it('同じ入力形の再コピーを検出し、違う単位契約と委譲を通す', () => {
  const path = 'packages/expression/src/math/example.test.ts';
  expect(copiedDegreeInputCount(path, OLD_DEGREE_INPUT)).toBe(1);
  expect(copiedDegreeInputCount(path, OLD_DEGREE_INPUT.replace('discrete-quantiles', 'probability'))).toBe(1);
  expect(copiedDegreeInputCount(path, OLD_DEGREE_INPUT.replace("angleUnit: 'degree'", "angleUnit: 'radian'"))).toBe(0);
  expect(copiedDegreeInputCount(path, "function input(source: string) { return specialMathTestRequest(source, 'degree', 'id'); }")).toBe(0);
  expect(copiedDegreeInputCount(path, '// ' + OLD_DEGREE_INPUT.split('\n').join('\n// '))).toBe(0);
});

// P16 group 12: only the original request/execute/decode pipeline, not independent numeric oracles.
const OLD_SPECIAL_EVALUATE = `function evaluate(source: string, angleUnit: 'degree' | 'radian' = 'radian') {
  const input=request(source,angleUnit),raw=executeMathWorkRequest({kind:'evaluate-math',serial:1,request:input},backend);
  return decodeMathWorkReply(raw,input,{operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(),declaredIds:new Set()}).result;
}`;
function copiedSpecialEvaluationCount(path: string, source: string): number {
  function fingerprints(file: ts.SourceFile): string[] {
    const rows: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'evaluate' && node.body && node.parameters.length === 2) {
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, node.body.getText(file));
        const tokens: string[] = [];
        for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) tokens.push(scanner.getTokenText());
        rows.push(JSON.stringify(tokens));
      }
      ts.forEachChild(node, visit);
    }
    visit(file); return rows;
  }
  const baseline = fingerprints(ts.createSourceFile('baseline.ts', OLD_SPECIAL_EVALUATE, ts.ScriptTarget.Latest, true));
  if (baseline.length !== 1) throw new Error('Missing evaluation baseline');
  return fingerprints(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)).filter(value => value === baseline[0]).length;
}

it('P16の特殊関数評価パイプラインをconsumerへ再コピーしない', () => {
  const files = productFiles(root, 'packages/expression/src/math', path => /\.test\.ts$/u.test(path));
  expect(files.filter(path => copiedSpecialEvaluationCount(path, readFileSync(resolve(root, path), 'utf8')) > 0)).toEqual([]);
});

it('同じ評価パイプラインを検出し、別serial・委譲・コメントを許す', () => {
  const path = 'packages/expression/src/math/example.test.ts';
  expect(copiedSpecialEvaluationCount(path, OLD_SPECIAL_EVALUATE)).toBe(1);
  expect(copiedSpecialEvaluationCount(path, OLD_SPECIAL_EVALUATE.replace('serial:1', 'serial:2'))).toBe(0);
  expect(copiedSpecialEvaluationCount(path, 'function evaluate(source: string, angleUnit: string) { return evaluateMathInput(request(source,angleUnit), backend); }')).toBe(0);
  expect(copiedSpecialEvaluationCount(path, '// ' + OLD_SPECIAL_EVALUATE.split('\n').join('\n// '))).toBe(0);
});

// P16 group 11: the original text/degree version-2 request shape, not other identity contracts.
const OLD_WORK_REQUEST = `function request(source: string) {
  return { source, notation: 'text', angleUnit: 'degree', coefficients: [],
    identity: { documentId: 'differential-equations', documentVersion: 2, editorId: 'X', inputRevision: 3 } };
}`;
function copiedWorkRequestCount(path: string, source: string): number {
  function fingerprints(file: ts.SourceFile): string[] {
    const rows: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'request' && node.body && node.parameters.length === 1) {
        const body = node.body.getText(file).replace(/(documentId\s*:\s*)['"][^'"]+['"]/gu, '$1"$document"');
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, body);
        const tokens: string[] = [];
        for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) tokens.push(scanner.getTokenText());
        rows.push(JSON.stringify(tokens));
      }
      ts.forEachChild(node, visit);
    }
    visit(file); return rows;
  }
  const baseline = fingerprints(ts.createSourceFile('baseline.ts', OLD_WORK_REQUEST, ts.ScriptTarget.Latest, true));
  if (baseline.length !== 1) throw new Error('Missing work request baseline');
  return fingerprints(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)).filter(value => value === baseline[0]).length;
}

it('P16のversion-2 work requestをconsumerへ再コピーしない', () => {
  const files = productFiles(root, 'packages/expression/src/math', path => /\.test\.ts$/u.test(path));
  expect(files.filter(path => copiedWorkRequestCount(path, readFileSync(resolve(root, path), 'utf8')) > 0)).toEqual([]);
});

it('同じwork requestを検出し、異なる版と委譲を許す', () => {
  const path = 'packages/expression/src/math/example.test.ts';
  expect(copiedWorkRequestCount(path, OLD_WORK_REQUEST)).toBe(1);
  expect(copiedWorkRequestCount(path, OLD_WORK_REQUEST.replace('differential-equations', 'equations'))).toBe(1);
  expect(copiedWorkRequestCount(path, OLD_WORK_REQUEST.replace('documentVersion: 2', 'documentVersion: 1'))).toBe(0);
  expect(copiedWorkRequestCount(path, 'function request(source: string) { return mathTestRequest(source, options); }')).toBe(0);
  expect(copiedWorkRequestCount(path, '// ' + OLD_WORK_REQUEST.split('\n').join('\n// '))).toBe(0);
});
