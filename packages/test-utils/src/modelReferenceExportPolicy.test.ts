import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const forbidden = new Set(['selectSubShape', 'selectMateTargetGeometry', 'rematchSubShapeRef']);
const modelDirectory = resolve(root, 'packages/model');
const canonical = (path: string): string => resolve(path).replaceAll('\\', '/');

interface ExportInspection {
  readonly names: readonly string[];
  readonly forbidden: readonly string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Use real symbol resolution: textual matches cannot distinguish comments, aliases or export-star. */
function inspectExports(entries: readonly string[], read: (path: string) => string | undefined): Map<string, ExportInspection> {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, noLib: true, types: [], noEmit: true, skipLibCheck: true };
  const host = ts.createCompilerHost(options);
  host.getCurrentDirectory = () => root;
  host.getSourceFile = (path, languageVersion) => {
    const source = read(canonical(path));
    return source === undefined ? undefined : ts.createSourceFile(canonical(path), source, languageVersion, true);
  };
  host.readFile = path => read(canonical(path));
  host.fileExists = path => read(canonical(path)) !== undefined;
  // This is an export inspection, not another workspace typecheck. External libraries and their types are irrelevant.
  host.resolveModuleNames = (names, containingFile) => names.map(name => {
    if (!name.startsWith('.')) return undefined;
    const path = canonical(resolve(dirname(containingFile), name.replace(/\.js$/u, '.ts')));
    return read(path) === undefined ? undefined : { resolvedFileName: path, extension: ts.Extension.Ts };
  });
  const program = ts.createProgram(entries.map(canonical), options, host);
  const checker = program.getTypeChecker();

  function forbiddenOrigins(symbol: ts.Symbol, visited: Set<ts.Symbol>): Set<string> {
    if (visited.has(symbol)) return new Set();
    visited.add(symbol);
    const result = new Set<string>();
    if (forbidden.has(symbol.getName())) result.add(symbol.getName());
    const collect = (target: ts.Symbol | undefined): void => {
      if (target !== undefined) for (const name of forbiddenOrigins(target, visited)) result.add(name);
    };
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) collect(checker.getAliasedSymbol(symbol));
    if ((symbol.flags & ts.SymbolFlags.Module) !== 0) {
      for (const member of checker.getExportsOfModule(symbol)) collect(member);
    }
    for (const declaration of symbol.declarations ?? []) {
      // Also catch an exported local const alias of an imported low-level function.
      if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
        let expression = declaration.initializer;
        while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) {
          expression = expression.expression;
        }
        if (ts.isIdentifier(expression)) collect(checker.getSymbolAtLocation(expression));
        if (ts.isPropertyAccessExpression(expression)) collect(checker.getSymbolAtLocation(expression.name));
      }
    }
    return result;
  }

  const results = new Map<string, ExportInspection>();
  for (const entry of entries) {
    const path = canonical(entry), source = program.getSourceFile(path);
    const symbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
    if (symbol === undefined) throw new Error(`Missing export module: ${path}`);
    const symbols = checker.getExportsOfModule(symbol);
    results.set(path, { names: symbols.map(value => value.getName()).sort(),
      forbidden: [...new Set(symbols.flatMap(value => [...forbiddenOrigins(value, new Set())]))].sort() });
  }
  return results;
}

function publicSourceEntries(value: unknown): string[] {
  if (typeof value === 'string') return value.startsWith('./src/') && value.endsWith('.ts') ? [resolve(modelDirectory, value)] : [];
  if (!record(value)) return [];
  return Object.entries(value).flatMap(([condition, entry]) => condition === 'types' ? [] : publicSourceEntries(entry));
}

it('keeps low-level matchers internal at every package entry and the kernel bridge', () => {
  const manifest: unknown = JSON.parse(readFileSync(resolve(modelDirectory, 'package.json'), 'utf8'));
  if (!record(manifest) || !record(manifest.exports)) throw new Error('Model package exports are missing');
  const bridge = resolve(modelDirectory, 'src/kernelBridge.ts');
  const index = resolve(modelDirectory, 'src/index.ts');
  const internal = resolve(modelDirectory, 'src/kernelBridge/subShapeMatching.ts');
  const entries = [...new Set([...publicSourceEntries(manifest.exports), bridge])];
  expect(entries).toContain(index);
  const cache = new Map<string, string | undefined>();
  const prefix = canonical(resolve(modelDirectory, 'src')) + '/';
  const read = (path: string): string | undefined => {
    if (!cache.has(path)) cache.set(path, path.startsWith(prefix) && path.endsWith('.ts') && existsSync(path)
      ? readFileSync(path, 'utf8') : undefined);
    return cache.get(path);
  };
  const inspections = inspectExports([...entries, internal], read);
  for (const entry of entries) expect(inspections.get(canonical(entry))?.forbidden, entry).toEqual([]);
  for (const entry of [index, bridge]) {
    for (const name of ['resolveSubShapeReference', 'resolveReplacementSubShapeReference', 'createSubShapeReferenceResolver']) {
      expect(inspections.get(canonical(entry))?.names, `${entry}: ${name}`).toContain(name);
    }
  }
  // The implementation is retained for internal counterexamples; removing the file is not the repair.
  expect(inspections.get(canonical(internal))?.forbidden).toEqual([...forbidden].sort());
});

function fixture(source: string, intermediate = ''): ExportInspection {
  const directory = resolve(root, '__reference_export_policy__');
  const index = canonical(resolve(directory, 'index.ts'));
  const files = new Map<string, string>([
    [index, source],
    [canonical(resolve(directory, 'internal.ts')), [...forbidden].map(name => `export function ${name}() { return null; }`).join('\n')
      + '\nexport function resolveSubShapeReference() { return { status: "ambiguous" }; }'],
    [canonical(resolve(directory, 'middle.ts')), intermediate],
  ]);
  const result = inspectExports([index], path => files.get(path)).get(index);
  if (result === undefined) throw new Error('Fixture export inspection is missing');
  return result;
}

describe('re-publication cannot hide behind another exported name', () => {
  for (const name of forbidden) {
    const examples = [
      `export { ${name} } from './internal.js';`,
      `export { ${name} as renamed } from './internal.js';`,
      `export { ${name} as "renamed" } from './internal.js';`,
      `import { ${name} as local } from './internal.js'; export { local as renamed };`,
      `import { ${name} as local } from './internal.js'; export const renamed = local;`,
      `import * as internal from './internal.js'; export const renamed = internal.${name};`,
    ];
    for (const [index, source] of examples.entries()) {
      it(`${name}: alias form ${index + 1}`, () => {
        expect(fixture(source).forbidden).toEqual([name]);
      });
    }
  }
});

it('follows star, namespace and intermediate barrel exports', () => {
  const expected = [...forbidden].sort();
  for (const source of ["export * from './internal.js';", "export * as internal from './internal.js';",
    "import * as internal from './internal.js'; export { internal };", "export * from './middle.js';"]) {
    expect(fixture(source, "export * from './internal.js';").forbidden).toEqual(expected);
  }
  expect(fixture("export { renamed as anotherName } from './middle.js';",
    "export { selectSubShape as renamed } from './internal.js';").forbidden).toEqual(['selectSubShape']);
});

it('keeps the ambiguity-aware resolver public and ignores comments and example strings', () => {
  const source = `export { resolveSubShapeReference } from './internal.js';
    // export { selectSubShape } from './internal.js';
    /* export * from './internal.js'; */
    export const example = "export { rematchSubShapeRef } from './internal.js';";`;
  expect(fixture(source)).toEqual({ names: ['example', 'resolveSubShapeReference'], forbidden: [] });
});

const p10PythonAssets = ["cas_equation_systems_test.py", "cas_equations_test.py", "cas_fourier_series_test.py", "cas_integrals_test.py", "cas_probability_test.py", "cas_region_integrals_test.py", "cas_transforms_test.py"] as const;
const p10FixedAssetConsumers = ["packages/ui/src/math/mathEquationResult.test.ts", "packages/ui/src/math/mathEquationSystemResult.test.ts", "packages/ui/src/math/mathFourierSeriesResult.test.ts", "packages/ui/src/math/mathIndefiniteIntegralResult.test.ts", "packages/ui/src/math/mathPaletteExamples.test.ts", "packages/ui/src/math/mathTransformResult.test.ts", "packages/ui/src/math/prepareDocumentMathIntegrals.test.ts"] as const;

/** Inspect literal file URLs only; dynamic fixtures and document/font oracles are separate boundaries. */
function privatePackageFileUrls(path: string, source: string): string[] {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const owner = /^packages\/([^/]+)\//u.exec(path)?.[1];
  const found: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node) && node.expression.getText(tree) === 'URL') {
      const value = node.arguments?.[0];
      if (value !== undefined && ts.isStringLiteralLike(value) && value.text.startsWith('.')) {
        const target = canonical(resolve(root, dirname(path), value.text));
        const targetPackage = /\/packages\/([^/]+)\/src\//u.exec(target)?.[1];
        if (targetPackage !== undefined && targetPackage !== owner) found.push(value.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}

it('P10の固定Python検査資産は明示exportから同じ実ファイルへ解決する', () => {
  const expression = resolve(root, 'packages/expression');
  const manifest: unknown = JSON.parse(readFileSync(resolve(expression, 'package.json'), 'utf8'));
  if (!record(manifest) || !record(manifest.exports)) throw new Error('Missing expression exports');
  expect(Object.keys(manifest.exports).filter(key => key.includes('*'))).toEqual([]);
  expect(Object.keys(manifest.exports).filter(key => key.startsWith('./testing-assets/')).sort())
    .toEqual(p10PythonAssets.map(name => './testing-assets/' + name).sort());
  const fromUi = createRequire(resolve(root, 'packages/ui/src/testing/publicAssetUrl.testSupport.ts'));
  expect(manifest.exports['./package.json']).toBe('./package.json');
  expect(fromUi.resolve('@pointercad/expression/package.json')).toBe(resolve(expression, 'package.json'));
  for (const name of p10PythonAssets) {
    expect(manifest.exports['./testing-assets/' + name]).toBe('./src/math/exactRuntime/' + name);
    const expected = resolve(expression, 'src/math/exactRuntime', name);
    const actual = fromUi.resolve('@pointercad/expression/testing-assets/' + name);
    expect(actual).toBe(expected);
    expect(readFileSync(actual)).toEqual(readFileSync(expected));
  }
  expect(() => fromUi.resolve('@pointercad/expression/src/math/exactRuntime/cas_equations_test.py')).toThrow();
  expect(() => fromUi.resolve('@pointercad/expression/testing-assets/not-published.py')).toThrow();
  for (const path of p10FixedAssetConsumers) {
    expect(privatePackageFileUrls(path, readFileSync(resolve(root, path), 'utf8')), path).toEqual([]);
  }
});

it('P10のfile URL反例は私有srcだけを拒否し正規assetと同層の読取を残す', () => {
  const owner = 'packages/ui/src/math/example.test.ts';
  expect(privatePackageFileUrls(owner, "new URL('../../../expression/src/math/exactRuntime/cas_equations_test.py', import.meta.url)"))
    .toEqual(['../../../expression/src/math/exactRuntime/cas_equations_test.py']);
  expect(privatePackageFileUrls(owner, "new URL('../../../model/src/private.json', import.meta.url)"))
    .toEqual(['../../../model/src/private.json']);
  for (const source of ["publicAssetUrl('@pointercad/expression/testing-assets/cas_equations_test.py')",
    "new URL('./localExactMathEngine.ts', import.meta.url)",
    "new URL('../../../help-content/docs/ja/assembly.md', import.meta.url)",
    "// new URL('../../../expression/src/private.py', import.meta.url)",
    "const example = \"new URL('../../../expression/src/private.py', import.meta.url)\";"]) {
    expect(privatePackageFileUrls(owner, source)).toEqual([]);
  }
});

it('P10の動的STEP資産は元ShapeのA/B/Cだけを同じ実ファイルへ解決する', () => {
  const manifest: unknown = JSON.parse(readFileSync(resolve(modelDirectory, 'package.json'), 'utf8'));
  if (!record(manifest) || !record(manifest.exports)) throw new Error('Missing model exports');
  const names = ['direct-seed-A.step', 'direct-seed-B.step', 'direct-seed-C.step'];
  expect(Object.keys(manifest.exports).filter(key => key.startsWith('./testing-assets/')).sort())
    .toEqual(names.map(name => './testing-assets/' + name));
  const fromUi = createRequire(resolve(root, 'packages/ui/src/testing/publicAssetUrl.testSupport.ts'));
  for (const name of names) {
    expect(manifest.exports['./testing-assets/' + name]).toBe('./src/part/fixtures/ex18/' + name);
    const expected = resolve(modelDirectory, 'src/part/fixtures/ex18', name);
    const actual = fromUi.resolve('@pointercad/model/testing-assets/' + name);
    expect(actual).toBe(expected); expect(readFileSync(actual)).toEqual(readFileSync(expected));
  }
  expect(() => fromUi.resolve('@pointercad/model/testing-assets/direct-seed-D.step')).toThrow();
  expect(() => fromUi.resolve('@pointercad/model/src/part/fixtures/ex18/direct-seed-A.step')).toThrow();
});
