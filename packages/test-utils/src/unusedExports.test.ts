import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { inspectUnusedExports, newUnusedExports, type UnusedExportReport, type UnusedExportRow } from '../../../scripts/lib/unusedExports.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
// P04 (gap-report.md 行996): the original proposal allows the unit time to grow by at most 2 minutes.
const P04_TIME_LIMIT_MS = 120_000;
const AUDIT_GAP_SHA256 = '2af7000dfaae86b42fbfeff36bdbe82c8ec3803389e86d2b9a6f872a9a4aa780';
// gap-report.md 表 4-1 の計。基準線は監査時の一覧のままで、現在の実数に合わせて増やさない。
const TABLE_4_1 = { dead: 49, internalOnly: 1650, testOnly: 1520 } as const;
// P03 wired these original dead-confirmed test helpers into real E2E tests (Root decision 2026-11-03). Only these keys
// may move from dead to test-only, and only while the spec imports them by name and one of its tests calls them.
const WIRED_SPEC = 'e2e/tests/beam-buckling-native.spec.ts';
const WIRED_ORIGINAL_HELPERS = [
  'packages/fem/src/bucklingNative.testSupport.ts#runBucklingNativeChecks',
  'packages/fem/src/transientNative.testSupport.ts#runTransientNativeChecks',
  'packages/fem/src/transientDampingNative.testSupport.ts#runTransientDampingNativeChecks',
  'packages/fem/src/transientBenchmark.testSupport.ts#runTransientBenchmark',
] as const;
// Files renamed after the audit with every export name kept (git -M R089/R100 in 60ec200b and ba0a6602; the first four are
// line-identical moves of the HEAD files). An audit key follows its file only inside its own category.
const SAME_NAME_FILE_RENAMES: readonly (readonly [string, string])[] = [
  ['packages/kernel/src/occt/loftSurfaceTestSupport.ts',
    'packages/kernel/src/occt/loftSurface.testSupport.ts'],
  ['packages/model/src/assembly/joints/mechanismCycleFixture.ts',
    'packages/model/src/assembly/joints/mechanismCycle.testSupport.ts'],
  ['packages/model/src/assembly/standard/steelGolden.fixture.ts',
    'packages/model/src/assembly/standard/steelGolden.testSupport.ts'],
  ['packages/model/src/assembly/standard/steelS45cOracle.fixture.ts',
    'packages/model/src/assembly/standard/steelS45cOracle.testSupport.ts'],
  ['packages/model/src/functionGeometry/sampleExplicitFunctionCurve.ts',
    'packages/model/src/functionGeometry/sampleExplicitFunctionCurve.testSupport.ts'],
  ['packages/model/src/part/ex18RouteBuilders.ts',
    'packages/model/src/part/ex18RouteBuilders.testSupport.ts'],
  ['packages/model/src/part/ex18RouteFixtures.ts',
    'packages/model/src/part/ex18RouteFixtures.testSupport.ts'],
  ['packages/model/src/part/ex18ShapeOracle.ts',
    'packages/model/src/part/ex18ShapeOracle.testSupport.ts'],
  ['packages/ui/src/viewport/dragSketch.retentionSupport.ts',
    'packages/ui/src/viewport/dragSketch.retentionSupport.testSupport.ts'],
];

interface Baseline {
  sourceSha256: string;
  counts: { dead: number; internalOnly: number; testOnly: number };
  deadConfirmed: string[];
  deadNeedsReview: string[];
  internalOnly: string[];
  testOnly: string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keyList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string' && item.includes('#'))) {
    throw new Error(`Invalid unused-export baseline list: ${name}`);
  }
  return value;
}

function readBaseline(): Baseline {
  const parsed: unknown = JSON.parse(readFileSync(resolve(root, 'packages/test-utils/src/unusedExportsBaseline.json'), 'utf8'));
  if (!record(parsed) || !record(parsed.counts) || typeof parsed.sourceSha256 !== 'string') throw new Error('Invalid unused-export baseline');
  const { dead, internalOnly, testOnly } = parsed.counts;
  if (typeof dead !== 'number' || typeof internalOnly !== 'number' || typeof testOnly !== 'number') throw new Error('Invalid baseline counts');
  return { sourceSha256: parsed.sourceSha256, counts: { dead, internalOnly, testOnly },
    deadConfirmed: keyList(parsed.deadConfirmed, 'deadConfirmed'), deadNeedsReview: keyList(parsed.deadNeedsReview, 'deadNeedsReview'),
    internalOnly: keyList(parsed.internalOnly, 'internalOnly'), testOnly: keyList(parsed.testOnly, 'testOnly') };
}

function visitNodes(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, child => { visitNodes(child, visit); });
}

/** Named value imports of the given helper keys (local name -> key) and the local name of Playwright's `test`. */
function namedImports(specPath: string, source: ts.SourceFile, helperKeys: readonly string[]) {
  const helpers = new Map<string, string>();
  let testName: string | undefined;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (statement.importClause?.isTypeOnly === true || bindings === undefined || !ts.isNamedImports(bindings)) continue;
    const spec = statement.moduleSpecifier.text;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      if (spec === '@playwright/test' && imported === 'test') testName = element.name.text;
      const target = spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(specPath), spec)).replace(/\.js$/u, '.ts') : null;
      if (target !== null && helperKeys.includes(`${target}#${imported}`)) helpers.set(element.name.text, `${target}#${imported}`);
    }
  }
  return { helpers, testName };
}

/** Top-level functions of the spec that call one of their own parameters: name -> indexes of the called parameters. */
function forwardingFunctions(source: ts.SourceFile): Map<string, Set<number>> {
  const forwarders = new Map<string, Set<number>>();
  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name === undefined || statement.body === undefined) continue;
    const parameters = statement.parameters.map(parameter => ts.isIdentifier(parameter.name) ? parameter.name.text : '');
    const called = new Set<number>();
    visitNodes(statement.body, node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && parameters.includes(node.expression.text)) {
        called.add(parameters.indexOf(node.expression.text));
      }
    });
    if (called.size > 0) forwarders.set(statement.name.text, called);
  }
  return forwarders;
}

/**
 * Helper keys that a top-level Playwright `test(...)` callback of the spec calls, directly or by passing the imported binding
 * to a top-level function of the spec that calls that parameter. A nested function counts only when it is passed to such a
 * function at a parameter that is called. An import alone, a string, a comment or an uninvoked closure is not a call.
 */
function wiredHelperRoutes(specPath: string, text: string, helperKeys: readonly string[]): Map<string, string> {
  const source = ts.createSourceFile(specPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const { helpers, testName } = namedImports(specPath, source, helperKeys);
  const forwarders = forwardingFunctions(source), routes = new Map<string, string>();
  const calledParameter = (node: ts.Node): boolean => {
    const call = node.parent;
    return ts.isCallExpression(call) && ts.isIdentifier(call.expression)
      && forwarders.get(call.expression.text)?.has(call.arguments.findIndex(argument => argument === node)) === true;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text, direct = helpers.get(callee), called = forwarders.get(callee);
      if (direct !== undefined && !routes.has(direct)) routes.set(direct, 'direct');
      node.arguments.forEach((argument, index) => {
        const forwarded = ts.isIdentifier(argument) ? helpers.get(argument.text) : undefined;
        if (called?.has(index) === true && forwarded !== undefined && !routes.has(forwarded)) routes.set(forwarded, `via ${callee}`);
      });
    }
    ts.forEachChild(node, child => { if (!ts.isFunctionLike(child) || calledParameter(child)) visit(child); });
  };
  for (const statement of source.statements) {
    if (testName === undefined || !ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression, body = call.arguments[call.arguments.length - 1];
    if (!ts.isIdentifier(call.expression) || call.expression.text !== testName
      || body === undefined || !(ts.isArrowFunction(body) || ts.isFunctionExpression(body))) continue;
    visit(body.body);
  }
  return routes;
}

/** The audit keys plus the same keys under the renamed file. Only the file part changes, never the name or category. */
function followRenames(keys: readonly string[], renames: readonly (readonly [string, string])[]): string[] {
  const next = new Map(renames);
  return [...keys, ...keys.flatMap(key => {
    const file = key.slice(0, key.indexOf('#')), renamed = next.get(file);
    return renamed === undefined ? [] : [`${renamed}${key.slice(file.length)}`];
  })];
}

interface TestOnlyCheck { moved: string[]; added: string[]; counted: number }

/** Test-only rows outside the baseline, except original dead-confirmed keys that a real test now calls (dead to test-only). */
function checkTestOnly(rows: readonly UnusedExportRow[], baseline: Pick<Baseline, 'deadConfirmed' | 'testOnly'>,
  wired: ReadonlySet<string>): TestOnlyCheck {
  const moved = rows.map(row => row.key).filter(key => wired.has(key) && baseline.deadConfirmed.includes(key));
  const added = newUnusedExports(rows, [...baseline.testOnly, ...moved]).map(row => row.key);
  return { moved, added, counted: rows.length - moved.length };
}

const fixtureRoot = resolve('unused-export-virtual-fixture');
const manifest = (name: string, exports: Record<string, string>) => JSON.stringify({ name, exports });
function inspect(entries: readonly (readonly [string, string])[]): UnusedExportReport {
  return inspectUnusedExports(fixtureRoot, new Map([
    ['packages/demo/package.json', manifest('@pointercad/demo', { '.': './src/index.ts' })],
    ['packages/use/package.json', manifest('@pointercad/use', { '.': './src/index.ts' })],
    ...entries,
  ]));
}
const keys = (rows: readonly { key: string }[]) => rows.map(row => row.key);
const lib = 'packages/demo/src/lib.ts';

describe('audit classification on virtual sources', () => {
  it('a new export nobody imports is dead, and a file-local use makes it file-internal only', () => {
    const result = inspect([[lib, 'export const unused = 1;\nexport function helper() { return 2; }\nexport const total = helper() + 1;'],
      ['packages/use/src/index.ts', "import { total } from '@pointercad/demo';\nexport const value = total;"],
      ['packages/demo/src/index.ts', "export { total } from './lib.js';"]]);
    // A public entry's own declaration that no other file imports is dead too (analyze.py).
    expect(keys(result.dead)).toEqual([`${lib}#unused`, 'packages/use/src/index.ts#value']);
    expect(keys(result.internalOnly)).toEqual([`${lib}#helper`]);
  });

  it('an import alias, a type-only import and a namespace member are uses of the original name', () => {
    const result = inspect([[lib, 'export const a = 1;\nexport interface Shape { x: number }\nexport const b = 2;\nexport const c = 3;'],
      ['packages/demo/src/user.ts', "import { a as renamed } from './lib.js';\nimport type { Shape } from './lib.js';\nimport * as ns from './lib.js';\nexport const s: Shape = { x: renamed + ns.b };"],
      ['packages/demo/src/main.test.ts', "import { s } from './user.js';\nvoid s;"]]);
    expect(keys(result.dead)).toEqual([`${lib}#c`]);
    expect(keys(result.testOnly)).toEqual(['packages/demo/src/user.ts#s']);
  });

  it('re-export only through an index, a comment and a string mention are not uses', () => {
    const result = inspect([[lib, 'export function republished() { return 1; }'],
      ['packages/demo/src/index.ts', "export { republished } from './lib.js';\nexport * from './lib.js';"],
      ['packages/use/src/index.ts', "// republished() is mentioned here\nexport const text = 'republished';"]]);
    expect(keys(result.dead)).toEqual([`${lib}#republished`, 'packages/use/src/index.ts#text']);
  });

  it('an export used only by tests, specs or test configuration is test-only', () => {
    const result = inspect([[lib, 'export const forTests = 1;\nexport const forProduct = 2;'],
      ['packages/demo/src/lib.test.ts', "import { forTests, forProduct } from './lib.js';\nvoid [forTests, forProduct];"],
      ['packages/use/src/index.ts', "import { forProduct } from '@pointercad/demo/lib';\nexport const v = forProduct;"],
      ['packages/demo/package.json', manifest('@pointercad/demo', { '.': './src/index.ts', './lib': './src/lib.ts' })]]);
    expect(keys(result.testOnly)).toEqual([`${lib}#forTests`]);
    expect(result.dead.map(row => row.path)).not.toContain(lib);
  });

  it('re-exports through a barrel resolve to the declaring file', () => {
    const result = inspect([[lib, 'export const deep = 1;'], ['packages/demo/src/middle.ts', "export * from './lib.js';"],
      ['packages/demo/src/index.ts', "export { deep as shallow } from './middle.js';"],
      ['packages/use/src/index.ts', "import { shallow } from '@pointercad/demo';\nexport const v = shallow;"]]);
    expect(keys(result.dead)).not.toContain(`${lib}#deep`);
  });

  it('dynamic imports keep destructured names and fall back to whole-module use otherwise', () => {
    const result = inspect([[lib, 'export const picked = 1;\nexport const other = 2;'],
      ['packages/demo/src/b.ts', 'export const viaWhole = 1;'],
      ['packages/use/src/index.ts', "export async function load(spec: string) {\n  const { picked } = await import('../../demo/src/lib.js');\n  const all = import('../../demo/src/b.js');\n  return [picked, all, spec];\n}"]]);
    expect(keys(result.dead)).toContain(`${lib}#other`);
    expect(keys(result.dead)).not.toContain('packages/demo/src/b.ts#viaWhole');
    expect(result.wholeModuleUses.map(use => use.target)).toEqual(['packages/demo/src/b.ts']);
  });

  it('a dynamic namespace without member access uses the whole module and is listed like the audit', () => {
    const result = inspect([['packages/demo/src/c.ts', 'export const wholeC = 1;'],
      ['packages/use/src/index.ts', "export async function load() {\n  const whole = await import('../../demo/src/c.js');\n  return whole;\n}"]]);
    expect(keys(result.dead)).not.toContain('packages/demo/src/c.ts#wholeC');
    expect(result.wholeModuleUses).toEqual([{ path: 'packages/use/src/index.ts', line: 2, spec: '../../demo/src/c.js', target: 'packages/demo/src/c.ts' }]);
  });

  it('a JSDoc link and an export clause are not uses, and an inline type import is a use', () => {
    const result = inspect([[lib, '/** See {@link documented}. */\nexport function documented() { return 1; }\nfunction hidden() { return 2; }\nexport { hidden as exposed };\nexport type Inline = number;'],
      ['packages/use/src/index.ts', "import { type Inline } from '../../demo/src/lib.js';\nexport const v: Inline = 1;"]]);
    expect(keys(result.dead)).toEqual([`${lib}#documented`, `${lib}#exposed`, 'packages/use/src/index.ts#v']);
    expect(keys(result.internalOnly)).toEqual([]);
  });

  it('an unresolved relative import is reported instead of being counted as zero', () => {
    const result = inspect([['packages/use/src/index.ts', "import { gone } from './missing.js';\nexport const v = gone;"]]);
    expect(result.unresolved).toEqual([{ path: 'packages/use/src/index.ts', line: 1, spec: './missing.js', kind: 'import' }]);
  });

  it('keeps the exact shipped rebuild input out of execution but never hides a workspace import or sibling module', () => {
    const shipped = 'packages/fem/runtime/sources/netgen-rebuild/fem-netgen-replacement.spec.ts';
    const template = readFileSync(resolve(root, shipped), 'utf8');
    expect(inspect([[shipped, template]]).unresolved).toEqual([]);
    const consumer = 'packages/use/src/index.ts';
    const spec = '../../fem/runtime/sources/netgen-rebuild/fem-netgen-replacement.spec.js';
    expect(inspect([[shipped, template], [consumer, `import '${spec}';`]]).unresolved)
      .toEqual([{ path: consumer, line: 1, spec, kind: 'import' }]);
    const sibling = 'packages/fem/runtime/sources/netgen-rebuild/workspaceHelper.ts';
    expect(inspect([[shipped, template], [sibling, "import './missing.js';"]]).unresolved)
      .toEqual([{ path: sibling, line: 1, spec: './missing.js', kind: 'import' }]);
  });

  it('scans the same rebuild spec after staging it into its actual isolated-copy execution location', () => {
    const shipped = 'packages/fem/runtime/sources/netgen-rebuild/fem-netgen-replacement.spec.ts';
    const staged = 'e2e/tests/fem-netgen-replacement.spec.ts';
    const template = readFileSync(resolve(root, shipped), 'utf8');
    const result = inspect([[staged, template]]);
    expect(result.unresolved.map(row => ({ path: row.path, spec: row.spec }))).toEqual([
      { path: staged, spec: '../../packages/fem/src/assets.js' },
      { path: staged, spec: '../../packages/fem/src/client.js' },
      { path: staged, spec: '../../packages/fem/src/protocol.js' },
      { path: staged, spec: '../../packages/fem/src/tetraMesh.js' },
    ]);
    expect(inspect([[staged, template],
      ['packages/fem/src/assets.ts', 'export const NETGEN_ASSETS = [];'],
      ['packages/fem/src/client.ts', 'export class FemClient {}'],
      ['packages/fem/src/protocol.ts', 'export type FemRequest = unknown;'],
      ['packages/fem/src/tetraMesh.ts', 'export const NETGEN_WHEEL = {};'],
    ]).unresolved).toEqual([]);
  });

  it('new URL assets resolve only when present, a directory base is not an import and a missing module stays unresolved', () => {
    // Specs copied from the P04 run of 2026-11-03 (reviewed-units-20261103-225117-306136/2-test-utils.log).
    const fit = 'packages/drawing/src/dimension/fitTable.test.ts', channel = 'packages/model/src/assembly/standard/steelChannelOracle.test.ts';
    const result = inspect([['docs/standards/jis-drawing/fits-jis-b-0401.json', '{}'],
      [fit, "const table = new URL('../../../../docs/standards/jis-drawing/fits-jis-b-0401.json', import.meta.url);\nvoid table;"],
      [channel, "const table = new URL('../../../../../docs/standards/jis/channel-jis-g-3192.json', import.meta.url);\nvoid table;"],
      ['packages/expression/src/math/cardinality.test.ts', "const runtime = new URL('./exactRuntime/', import.meta.url);\nvoid runtime;"],
      ['e2e/offline-candidate.config.ts', "export const root = new URL('..', import.meta.url);"],
      ['packages/use/src/escape.test.ts', "const outside = new URL('../../../../', import.meta.url);\nvoid outside;"],
      ['packages/use/src/index.ts', "import { gone } from './missing.js';\nexport const v = gone;"]]);
    expect(result.unresolved).toEqual([
      { path: channel, line: 1, spec: '../../../../../docs/standards/jis/channel-jis-g-3192.json', kind: 'url' },
      { path: 'packages/use/src/escape.test.ts', line: 1, spec: '../../../../', kind: 'url' },
      { path: 'packages/use/src/index.ts', line: 1, spec: './missing.js', kind: 'import' },
    ]);
  });

  it('tool files are consumers only and new URL worker targets are not classified', () => {
    const result = inspect([[lib, 'export const fromTool = 1;'], ['scripts/build.mjs', "import { fromTool } from '../packages/demo/src/lib.js';\nexport const unusedTool = fromTool;"],
      ['packages/demo/src/run.worker.ts', 'export const workerOnly = 1;'],
      ['packages/use/src/index.ts', "export const url = new URL('../../demo/src/run.worker.ts', import.meta.url);"]]);
    expect(keys(result.dead)).not.toContain(`${lib}#fromTool`);
    expect(keys(result.dead).some(key => key.startsWith('scripts/'))).toBe(false);
    expect(keys(result.dead)).not.toContain('packages/demo/src/run.worker.ts#workerOnly');
  });

  it('a type-only namespace import is a reference like the audit\'s typeof import(); named members and value namespaces are uses', () => {
    // Copied from the 2026-11-04 P04 failure: prepareBeamAnalysis.friction.test.ts mocks a module through `typeof Module`.
    const result = inspect([[lib, 'export interface Shape { x: number }\nexport const passed = 2;\nexport const total = passed + 1;\nexport const unused = 3;'],
      ['packages/demo/src/b.ts', 'export const viaValueNs = 1;'],
      ['packages/demo/src/mock.test.ts', ["import type * as Whole from './lib.js';", "import type * as Named from './lib.js';",
        "import * as valueNs from './b.js';", "vi.mock('./lib.js', async importOriginal => ({ ...await importOriginal<typeof Whole>() }));",
        'const shape: Named.Shape = { x: 1 };', 'void [shape, valueNs];'].join('\n')]]);
    expect(keys(result.testOnly)).toEqual(['packages/demo/src/b.ts#viaValueNs', `${lib}#Shape`]);
    expect(keys(result.internalOnly)).toEqual([`${lib}#passed`]);
    expect(keys(result.dead)).toEqual([`${lib}#total`, `${lib}#unused`]);
  });

  it('an audit key follows a same-name file rename only inside its category; a new name or a dead key stays new', () => {
    const before = 'packages/demo/src/oracleFixture.ts', after = 'packages/demo/src/oracle.testSupport.ts';
    const accepted = followRenames([`${before}#oracle`, `${lib}#kept`], [[before, after]]);
    expect(accepted).toEqual([`${before}#oracle`, `${lib}#kept`, `${after}#oracle`]);
    const row = (key: string) => ({ key, path: key.slice(0, key.indexOf('#')), line: 1, name: key.slice(key.indexOf('#') + 1), kind: 'const', typeOnly: false });
    const current = [`${after}#oracle`, `${after}#fresh`, `${after}#wasDead`, `${lib}#renamedAway`].map(row);
    // wasDead was a dead audit key of the old file, so as a test-only key it is new; an unrelated rename is not followed.
    expect(keys(newUnusedExports(current, followRenames([`${before}#oracle`], [[before, after], [lib, 'packages/demo/src/other.ts']]))))
      .toEqual([`${after}#fresh`, `${after}#wasDead`, `${lib}#renamedAway`]);
  });

  it('newUnusedExports reports only keys outside the accepted list', () => {
    const row = { key: 'p.ts#a', path: 'p.ts', line: 1, name: 'a', kind: 'const', typeOnly: false };
    expect(newUnusedExports([row, { ...row, key: 'p.ts#b', name: 'b' }], ['p.ts#a'])).toEqual([{ ...row, key: 'p.ts#b', name: 'b' }]);
  });

  it('an original dead helper that a real test calls moves to test-only; a new, import-only or uncalled helper fails', () => {
    const support = 'packages/demo/src/run.testSupport.ts', spec = 'e2e/tests/demo.spec.ts';
    const specText = ["import { test } from '@playwright/test';",
      "import { direct, forwarded, fresh, importOnly, inline, mentioned, uncalled } from '../../packages/demo/src/run.testSupport.js';",
      'async function wrap(label: string, check: () => Promise<void>) { void label; await check(); }',
      "test('direct', async () => { await direct(); await fresh(); const later = () => uncalled(); void later; });",
      "test('forwarded', async () => { await wrap('mentioned', forwarded); await wrap('inline', async () => { await inline(); }); console.log('importOnly'); });"].join('\n');
    const names = ['direct', 'forwarded', 'fresh', 'importOnly', 'inline', 'mentioned', 'uncalled'], key = (name: string) => `${support}#${name}`;
    const result = inspect([[support, names.map(name => `export async function ${name}() { return '${name}'; }`).join('\n')], [spec, specText]]);
    const original = names.filter(name => name !== 'fresh').map(key);
    const routes = wiredHelperRoutes(spec, specText, original);
    expect([...routes]).toEqual([[key('direct'), 'direct'], [key('forwarded'), 'via wrap'], [key('inline'), 'direct']]);
    expect(checkTestOnly(result.testOnly, { deadConfirmed: original, testOnly: [] }, new Set(routes.keys()))).toEqual({
      moved: ['direct', 'forwarded', 'inline'].map(key), added: ['fresh', 'importOnly', 'mentioned', 'uncalled'].map(key), counted: 4 });
    // A called helper that the original baseline does not list as dead is still a new test-only export.
    expect(checkTestOnly(result.testOnly, { deadConfirmed: [], testOnly: [] }, new Set(routes.keys())).added).toEqual(names.map(key));
  });

  it('deducts the four original category moves exactly once and still counts a genuinely new helper', () => {
    const fresh = 'packages/demo/src/fresh.ts#newHelper';
    const rows = [...WIRED_ORIGINAL_HELPERS, fresh].map(key => ({ key,
      path: key.slice(0, key.indexOf('#')), name: key.slice(key.indexOf('#') + 1),
      kind: 'function', line: 1, typeOnly: false }));
    const result = checkTestOnly(rows, { deadConfirmed: [...WIRED_ORIGINAL_HELPERS], testOnly: [] },
      new Set(WIRED_ORIGINAL_HELPERS));
    expect(result).toEqual({ moved: [...WIRED_ORIGINAL_HELPERS], added: [fresh], counted: 1 });
  });
});

describe('audit resolution on real files', () => {
  it('present assets inside the workspace resolve; missing, outside, linked-out and build-only targets stay unresolved', () => {
    // Specs copied from the P04 run of 2026-11-03. Virtual sources cannot reach the filesystem check, so this case writes
    // real files into one fresh directory under scratchpad/temp (never walked by the P04 scan) and removes only that.
    const tempParent = resolve(root, 'scratchpad/temp'), prefix = 'unused-exports-real-';
    mkdirSync(tempParent, { recursive: true });
    const created = mkdtempSync(join(tempParent, prefix)), workspace = join(created, 'workspace');
    const files: Record<string, string> = {
      'docs/standards/jis-drawing/fits-jis-b-0401.json': '{}',
      'packages/drawing/src/dimension/fitTable.test.ts': "const table = new URL('../../../../docs/standards/jis-drawing/fits-jis-b-0401.json', import.meta.url);\nvoid table;\n",
      'packages/model/src/assembly/standard/steelChannelOracle.test.ts': "const table = new URL('../../../../../docs/standards/jis/channel-jis-g-3192.json', import.meta.url);\nvoid table;\n",
      'packages/fem/runtime/assets/beamFrictionContact.py': 'print(1)\n',
      'packages/fem/src/frictionContactOffline.test.ts': "import contactSource from '../runtime/assets/beamFrictionContact.py?raw';\nimport runtimeSource from '../runtime/assets/beamFrictionRuntime.py?raw';\nvoid [contactSource, runtimeSource];\n",
      'node_modules/.pnpm/opencascade.js/node_modules/opencascade.js/dist/opencascade.full.wasm': 'wasm',
      'apps/web/vite.config.ts': "export const wasm = new URL('../../packages/kernel/node_modules/opencascade.js/dist/opencascade.full.wasm', import.meta.url);\n",
      'apps/web/src/occtPreviewHeaders.test.ts': "const temp = new URL('../../../scratchpad/temp/', import.meta.url);\nvoid temp;\n",
      'packages/expression/src/math/cardinality.test.ts': "const runtime = new URL('./exactRuntime/', import.meta.url);\nvoid runtime;\n",
      'packages/use/src/escape.test.ts': "const outside = new URL('../../../../', import.meta.url);\nvoid outside;\n",
      'packages/use/src/outside.test.ts': "const secret = new URL('../../../../outside/secret.json', import.meta.url);\nvoid secret;\n",
      'packages/use/src/linked.test.ts': "const secret = new URL('../../../docs/linked/secret.json', import.meta.url);\nvoid secret;\n",
      'packages/demo/dist/generated.js': 'export const generated = 1;\n',
      'packages/demo/src/built.ts': "import { generated } from '../dist/generated.js';\nexport const b = generated;\n",
      'packages/demo/src/lib.ts': 'export const used = 1;\nexport const unused = 2;\nexport const forTest = 3;\n',
      'packages/demo/src/lib.test.ts': "import { forTest } from './lib.js';\nvoid forTest;\n",
      'packages/use/src/index.ts': "import { gone } from './missing.js';\nimport { used } from '../../demo/src/lib.js';\nexport const v = [gone, used];\n",
      'scripts/tool.mjs': "export const t = new URL('../missing-tool-asset.json', import.meta.url);\n",
    };
    if (!isAbsolute(created) || dirname(created) !== tempParent || !basename(created).startsWith(prefix)) {
      throw new Error(`Refusing to remove a directory this test did not create: ${created}`);
    }
    try {
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(dirname(join(workspace, name)), { recursive: true });
        writeFileSync(join(workspace, name), text);
      }
      // A file that exists outside the workspace, reached by '../' and through a link (a junction on Windows).
      mkdirSync(join(created, 'outside'));
      writeFileSync(join(created, 'outside/secret.json'), '{}');
      symlinkSync(join(created, 'outside'), join(workspace, 'docs/linked'), 'junction');
      // pnpm links a package into the workspace's own node_modules/.pnpm, so its assets stay inside the workspace.
      mkdirSync(join(workspace, 'packages/kernel/node_modules'), { recursive: true });
      symlinkSync(join(workspace, 'node_modules/.pnpm/opencascade.js/node_modules/opencascade.js'),
        join(workspace, 'packages/kernel/node_modules/opencascade.js'), 'junction');
      const report = inspectUnusedExports(workspace);
      const order = (row: { path: string; line: number }) => `${row.path}#${row.line}`;
      expect([...report.unresolved].sort((a, b) => order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0)).toEqual([
        { path: 'packages/demo/src/built.ts', line: 1, spec: '../dist/generated.js', kind: 'import' },
        { path: 'packages/fem/src/frictionContactOffline.test.ts', line: 2, spec: '../runtime/assets/beamFrictionRuntime.py?raw', kind: 'import' },
        { path: 'packages/model/src/assembly/standard/steelChannelOracle.test.ts', line: 1, spec: '../../../../../docs/standards/jis/channel-jis-g-3192.json', kind: 'url' },
        { path: 'packages/use/src/escape.test.ts', line: 1, spec: '../../../../', kind: 'url' },
        { path: 'packages/use/src/index.ts', line: 1, spec: './missing.js', kind: 'import' },
        { path: 'packages/use/src/linked.test.ts', line: 1, spec: '../../../docs/linked/secret.json', kind: 'url' },
        { path: 'packages/use/src/outside.test.ts', line: 1, spec: '../../../../outside/secret.json', kind: 'url' },
      ]);
      expect(keys(report.testOnly)).toEqual(['packages/demo/src/lib.ts#forTest']);
    } finally {
      rmSync(created, { recursive: true, force: true });
    }
    expect(existsSync(created)).toBe(false);
  });
});

describe('original dead test helpers wired into real E2E tests', () => {
  it('lists only original dead-confirmed keys, and the real spec calls the wired ones from its tests', () => {
    const baseline = readBaseline();
    expect(WIRED_ORIGINAL_HELPERS.filter(key => !baseline.deadConfirmed.includes(key))).toEqual([]);
    const routes = wiredHelperRoutes(WIRED_SPEC, readFileSync(resolve(root, WIRED_SPEC), 'utf8'), WIRED_ORIGINAL_HELPERS);
    // runBucklingNativeChecks is called in its test; the transient checks are passed to transientChecks, which calls them.
    expect(WIRED_ORIGINAL_HELPERS.map(key => routes.get(key))).toEqual(['direct', 'via transientChecks', 'via transientChecks', 'direct']);
  });
});

describe('same-name file renames since the audit', () => {
  it('each old file is in the audit lists and gone, and its successor exists and is not in the audit lists', () => {
    const baseline = readBaseline();
    const files = new Set([...baseline.deadConfirmed, ...baseline.deadNeedsReview, ...baseline.internalOnly, ...baseline.testOnly]
      .map(key => key.slice(0, key.indexOf('#'))));
    expect(SAME_NAME_FILE_RENAMES.map(([before, after]) => [files.has(before), files.has(after), existsSync(resolve(root, before)),
      existsSync(resolve(root, after))])).toEqual(SAME_NAME_FILE_RENAMES.map(() => [true, false, false, true]));
  });
});

describe('P04: unused exports do not increase beyond the audit baseline', () => {
  let report: UnusedExportReport;
  const baseline = readBaseline();
  beforeAll(() => { report = inspectUnusedExports(root); }, P04_TIME_LIMIT_MS);

  it('binds the baseline to the audit table without adapting it to the current tree', () => {
    expect(baseline.sourceSha256).toBe(AUDIT_GAP_SHA256);
    expect(baseline.counts).toEqual(TABLE_4_1);
    expect(baseline.deadConfirmed.length + baseline.deadNeedsReview.length).toBe(TABLE_4_1.dead);
    expect([baseline.deadConfirmed.length, baseline.deadNeedsReview.length]).toEqual([42, 7]);
    expect(new Set(baseline.internalOnly).size).toBe(TABLE_4_1.internalOnly);
    expect(new Set(baseline.testOnly).size).toBe(TABLE_4_1.testOnly);
  });

  it('scans the workspace and leaves no import unresolved', () => {
    expect(report.files).toBeGreaterThan(3000);
    expect(report.unresolved).toEqual([]);
  });

  it('removes confirmed dead exports and does not exceed the original category counts', () => {
    // P04 table 9 fixes category counts, not the identity of every key. Newly introduced public types or test helpers
    // may replace removed ones within the unchanged caps. Keep their names in diagnostics; do not turn the baseline
    // inventory into a ban on new APIs. P03 still requires all 42 confirmed-dead exports to disappear.
    // Only the seven original unresolved audit decisions remain separately visible; no new dead export is allowed.
    // The four original helpers wired into real E2E tests keep their already documented category-move treatment.
    const renamed = (keys: readonly string[]) => followRenames(keys, SAME_NAME_FILE_RENAMES);
    const wired = wiredHelperRoutes(WIRED_SPEC, readFileSync(resolve(root, WIRED_SPEC), 'utf8'), WIRED_ORIGINAL_HELPERS);
    const testOnly = checkTestOnly(report.testOnly, { deadConfirmed: baseline.deadConfirmed, testOnly: renamed(baseline.testOnly) },
      new Set(wired.keys()));
    expect.soft(newUnusedExports(report.dead, baseline.deadNeedsReview).map(row => row.key)).toEqual([]);
    const newInternal = newUnusedExports(report.internalOnly, renamed(baseline.internalOnly)).map(row => row.key);
    expect.soft(report.internalOnly.length, `internal-only additions within the fixed count: ${newInternal.join(', ')}`)
      .toBeLessThanOrEqual(TABLE_4_1.internalOnly);
    expect.soft(testOnly.counted, `test-only additions: ${testOnly.added.join(', ')}; original category moves: ${testOnly.moved.join(', ')}`)
      .toBeLessThanOrEqual(TABLE_4_1.testOnly);
  });
});
